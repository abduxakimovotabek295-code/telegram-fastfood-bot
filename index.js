/**
 * bot.js
 * Node.js single-file Telegram bot with 10 features:
 * 1) JSON user database
 * 2) Multiple admins
 * 3) /users command (stats)
 * 4) /help menu
 * 5) Admin reply by @@ID or @username
 * 6) Broadcast with media (photo, video, document)
 * 7) Inline buttons (example retained)
 * 8) Forward tracking
 * 9) Scheduled announcements
 * 10) Anti-spam & simple FAQ auto-reply
 *
 * Required packages:
 * npm i node-telegram-bot-api
 *
 * Run:
 * node bot.js
 */

const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");

// === CONFIGURE === //
const TOKEN = process.env.TELEGRAM_TOKEN; // <-- o'zgartiring
const ADMINS = [7397994103 /*, boshqa admin id lar qo'shish */]; // <-- admin id larini qo'shing
const USERS_FILE = path.join(__dirname, "users.json");
const SCHEDULE_FILE = path.join(__dirname, "schedules.json");
const SPAM_WINDOW_MS = 60 * 1000; // 1 daqiqa oynasi
const SPAM_LIMIT = 6; // shu oynada ruxsat etilgan xabarlar soni
// ================== //

const bot = new TelegramBot(TOKEN, { polling: true });

// In-memory caches (saqlash bilan birga)
let users = loadJSON(USERS_FILE, {});
let schedules = loadJSON(SCHEDULE_FILE, []);

// Anti-spam map: id -> [timestamps]
const messageTimes = new Map();

// --- Rasm URL manzilari ---
const IMAGE_PATHS = {
  BURGER:
    "https://img-s-msn-com.akamaized.net/tenant/amp/entityid/AA1LgWWl.img?w=3994&h=1997&m=4&q=79",
  PIZZA:
    "https://dlq00ggnjruqn.cloudfront.net/prometheus/getImage?id=169236&amp;width=640&amp;height=390",
  HOTDOG:
    "https://img-s-msn-com.akamaized.net/tenant/amp/entityid/AA1M0M1v.img?w=780&h=438&m=4&q=91",
  FRI: "https://static.tildacdn.com/tild3738-3061-4661-a432-353865383832/photo.jpg",
};

// --- INSTAGRAM HAVOLASI ---
const INSTAGRAM_URL = "https://instagram.com/telegram"; // <-- BU YERNI O'ZGARTIRING

// --- ASOSIY REPLY KEYBOARD TUGMALARI (o'zgarishsiz) ---
const REPLY_KEYBOARD = [["Menu"]];

// --- FAST FOOD MENYU TUGMALARI (Instagram qo'shildi) ---
const FAST_FOOD_MENU = [
  ["Burger 🍔", "Pizza 🍕"],
  ["Hot Dog 🌭", "Kartoshka Fri 🍟"],
  ["Instagram"], // <--- YENGI QO'SHILDI
  ["🔙 Asosiy Menyuga Qaytish"],
];

// Simple FAQ (kalit so'z -> javob)
const FAQ = [
  {
    keys: ["narx", "price"],
    resp: "📌 Kurs narxi: 100 000 so'm (1 oy). Batafsil so'rang yoki /contact bilan bog'laning.",
  },
  {
    keys: ["qachon", "vaqt", "when"],
    resp: "🕒 Darslar dushanbadan jumagacha, soat 18:00 da boshlanadi.",
  },
  {
    keys: ["manzil", "address"],
    resp: "📍 Manzil: Namangan shahri, Boborahim Mashrab ko'chasi, 12-uy.",
  },
];

// Helper: load JSON safe
function loadJSON(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2));
      return fallback;
    }
    const data = fs.readFileSync(filePath, "utf8");
    return JSON.parse(data || JSON.stringify(fallback));
  } catch (err) {
    console.error("JSON load error:", err);
    return fallback;
  }
}

function saveJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("JSON save error:", err);
  }
}

// Add or update user in DB
function addUser(msg) {
  const chatId = String(msg.chat.id);
  const username = msg.from.username || null;
  const first_name = msg.from.first_name || "";
  const last_name = msg.from.last_name || "";
  const now = new Date().toISOString();

  if (!users[chatId]) {
    users[chatId] = {
      id: chatId,
      username,
      first_name,
      last_name,
      first_seen: now,
      last_seen: now,
      messages: 0,
      forwarded_from: [],
    };
    console.log("✅ Foydalanuvchi qo'shildi:", chatId, username);
  } else {
    users[chatId].username = username;
    users[chatId].last_seen = now;
  }
  saveJSON(USERS_FILE, users);
}

// Anti-spam check: returns true if allowed, false if spam
function checkSpam(chatId) {
  const id = String(chatId);
  const now = Date.now();
  if (!messageTimes.has(id)) messageTimes.set(id, []);
  const arr = messageTimes.get(id);

  // remove old timestamps
  while (arr.length && now - arr[0] > SPAM_WINDOW_MS) arr.shift();

  arr.push(now);
  messageTimes.set(id, arr);

  if (arr.length > SPAM_LIMIT) return false;
  return true;
}

// Check if sender is admin
function isAdmin(id) {
  return ADMINS.includes(Number(id));
}

// Build /help text
function getHelpText(isAdminUser = false) {
  let text = `🤖 Bot yordamchi menyusi\n\nFoydali buyruqlar:\n`;
  text += `/help - yordam menyusi\n`;
  text += `/start - botni ishga tushirish (asosiy menyuni ko'rsatadi)\n`;
  text += `/menu - asosiy menyuni (tugmalarni) ko'rsatish\n`;
  text += `/contact - admin bilan bog'lanish\n\n`;
  if (isAdminUser) {
    text += `Admin buyruqlari:\n`;
    text += `/users - foydalanuvchilar statistikasi\n`;
    text += `Siz admin sifatida: @@ID yoki @username yordamida javob yuborishingiz mumkin.\n`;
    text += `E'lon yuborish uchun media (rasm/video/pdf) yuboring, yoki matnni *(matn)* shaklida yuboring.\n`;
    text += `!schedule YYYY-MM-DD HH:MM matn - rejalashtirish uchun\n`;
  }
  return text;
}

// Send broadcast (supports text or media)
async function broadcastFromAdmin(adminChatId, message) {
  // message may be a message object with media
  // If message contains photo/video/document etc., forward to users
  const entries = Object.values(users);
  for (const u of entries) {
    try {
      if (message.photo || message.video || message.document || message.audio) {
        // forward full message to keep media
        await bot.forwardMessage(u.id, adminChatId, message.message_id);
      } else {
        // text broadcast
        await bot.sendMessage(u.id, `📢 *E'lon:*\n${message.text || ""}`, {
          parse_mode: "Markdown",
        });
      }
    } catch (err) {
      // ignore errors for blocked users, but optionally log
      // console.error("Broadcast error to", u.id, err.message);
    }
  }
  bot.sendMessage(adminChatId, "📡 E'lon barcha foydalanuvchilarga yuborildi!");
}

// Schedule runner: check every 30s
setInterval(async () => {
  const now = new Date();
  const due = schedules.filter((s) => new Date(s.when) <= now && !s.sent);
  for (const s of due) {
    // send to all users
    for (const uid of Object.keys(users)) {
      try {
        if (s.type === "text") {
          await bot.sendMessage(
            uid,
            `📢 *Rejalashtirilgan e'lon:*\n${s.text}`,
            { parse_mode: "Markdown" }
          );
        } else if (s.type === "forward" && s.from && s.message_id) {
          await bot.forwardMessage(uid, s.from, s.message_id);
        }
      } catch (err) {
        // ignore send errors
      }
    }
    s.sent = true;
    s.sent_at = new Date().toISOString();
    saveJSON(SCHEDULE_FILE, schedules);
    console.log("📅 Rejalashtirilgan e'lon yuborildi:", s.id);
  }
}, 30 * 1000);

// Generate small unique id for schedules
function genId() {
  return Math.random().toString(36).slice(2, 9);
}

// --- JAVOB KLAVIATURASINI YUBORISH FUNKSIYASI (ASOSIY MENYU) ---
function sendReplyKeyboard(chatId, text = "Asosiy menyuni tanlang:") {
  const opts = {
    reply_markup: {
      keyboard: REPLY_KEYBOARD,
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
  bot.sendMessage(chatId, text, opts);
}

// --- JAVOB KLAVIATURASINI YUBORISH FUNKSIYASI (FAST FOOD MENYU) ---
function sendFastFoodMenu(chatId, text = "🍟 Fast Food Mahsulotlari Menyusi:") {
  const opts = {
    reply_markup: {
      keyboard: FAST_FOOD_MENU,
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
  bot.sendMessage(chatId, text, opts);
}

// Inline keyboard example handler
function sendExampleInline(chatId) {
  const opts = {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Ro'yxatdan o'tish (Inline)",
            callback_data: "action_register",
          },
        ],
        [{ text: "Bog'lanish (Link)", url: "https://t.me/telegram_id" }],
      ],
    },
  };
  bot.sendMessage(chatId, "Quyidagi inline tugmalardan foydalaning:", opts);
}

// Process admin command to schedule
async function handleScheduleCommand(adminId, text, msg) {
  // Format: !schedule 2025-12-31 20:30 Matn...
  const parts = text.split(" ");
  if (parts.length < 3) {
    bot.sendMessage(adminId, "❗ Format: !schedule YYYY-MM-DD HH:MM matn");
    return;
  }
  const datePart = parts[1];
  const timePart = parts[2];
  const whenStr = `${datePart} ${timePart}`;
  const when = new Date(whenStr);
  if (isNaN(when)) {
    bot.sendMessage(
      adminId,
      "❗ Sana/vaqt noto'g'ri. Misol: !schedule 2025-12-31 20:30 Xabar matni"
    );
    return;
  }
  const textPart = parts.slice(3).join(" ");
  const item = {
    id: genId(),
    type: "text",
    when: when.toISOString(),
    text: textPart,
    created_by: adminId,
    created_at: new Date().toISOString(),
    sent: false,
  };
  schedules.push(item);
  saveJSON(SCHEDULE_FILE, schedules);
  bot.sendMessage(
    adminId,
    `📆 E'lon ${when.toISOString()} ga rejalashtirildi (ID: ${item.id})`
  );
}

// Message handler
bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = msg.text || "";
    const fromId = msg.from.id;

    // Track forwarded_from if message is forwarded
    if (msg.forward_from_chat || msg.forward_from) {
      // store forwarded origin for stats
      addUser(msg);
      const uid = String(chatId);
      if (!users[uid].forwarded_from) users[uid].forwarded_from = [];
      users[uid].forwarded_from.push({
        date: new Date().toISOString(),
        from: msg.forward_from_chat
          ? msg.forward_from_chat.title
          : msg.forward_from
          ? `${msg.forward_from.first_name}`
          : "unknown",
      });
      saveJSON(USERS_FILE, users);
    }

    // Add/update user
    addUser(msg);
    users[String(chatId)].messages += 1;
    saveJSON(USERS_FILE, users);

    // Anti-spam (Adminlar uchun o'chirildi)
    if (!isAdmin(fromId)) {
      // Agar foydalanuvchi Admin bo'lmasa, spamni tekshir
      if (!checkSpam(chatId)) {
        // warn user or temporarily block
        bot.sendMessage(
          chatId,
          "⚠️ Siz juda tez-tez xabar yuboryapsiz. Iltimos, biroz kuting."
        );
        return;
      }
    }

    // --- ASOSIY BUYRUQLAR VA MENYU ---

    // /start
    if (text === "/start") {
      sendReplyKeyboard(
        chatId,
        "🤖 Assalomu alaykum! Botga xush kelibsiz. Quyidagi **Menu** tugmasini tanlang."
      );
      return;
    }

    // /menu
    if (text === "/menu") {
      sendReplyKeyboard(chatId);
      return;
    }

    // /help
    if (text === "/help") {
      bot.sendMessage(chatId, getHelpText(isAdmin(fromId)), {
        parse_mode: "Markdown",
      });
      return;
    }

    // /contact
    if (text === "/contact") {
      const adm = ADMINS[0];
      let admDisplay = adm ? `@admin` : "admin";
      bot.sendMessage(
        chatId,
        `Admin bilan bog'lanish: ${admDisplay}\nAgar shaxsiy muammo bo'lsa, botga xabar yuboring va adminlar ko'radi.`
      );
      return;
    }

    // --- REPLY KEYBOARD TUGMALARIGA JAVOB BERISH MANTIQI ---
    switch (text) {
      case "Menu":
        // Asosiy "Menu" tugmasi bosilganda, Fast Food menyusini yuborish
        sendFastFoodMenu(chatId);
        return;

      case "Instagram":
        // "Instagram" tugmasi bosilganda Link tugmasini yuborish (XAVFSIZ YO'NALTIRISH)
        const instagramOpts = {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "📸 Bizning Instagram sahifamiz", url: INSTAGRAM_URL }, // <-- Inline tugma (rasmiy havolaga yo'naltiradi)
              ],
            ],
          },
        };
        bot.sendMessage(
          chatId,
          "Bizning ijtimoiy tarmoqlarimizga tashrif buyuring:",
          instagramOpts
        );
        return;

      // Fast Food Menu Tugmalariga Javob (Rasmlar URL'idan + Instagram tugmasi)
      case "Burger 🍔":
        await bot.sendPhoto(chatId, IMAGE_PATHS.BURGER, {
          caption:
            "🍔 **Burgerlar bo'limi.** Klassik, chizburger va boshqalar.",
          parse_mode: "Markdown",
          // Instagram Inline Tugmasi qo'shildi
          reply_markup: {
            inline_keyboard: [
              [{ text: "📸 Instagram orqali ko'rish", url: INSTAGRAM_URL }],
            ],
          },
        });
        return;

      case "Pizza 🍕":
        await bot.sendPhoto(chatId, IMAGE_PATHS.PIZZA, {
          caption:
            "🍕 **Pizzalar bo'limi.** Pepperoni, Margarita, tovuqli va boshqalar.",
          parse_mode: "Markdown",
          // Instagram Inline Tugmasi qo'shildi
          reply_markup: {
            inline_keyboard: [
              [{ text: "📸 Instagram orqali ko'rish", url: INSTAGRAM_URL }],
            ],
          },
        });
        return;

      case "Hot Dog 🌭":
        await bot.sendPhoto(chatId, IMAGE_PATHS.HOTDOG, {
          caption:
            "🌭 **Hot Doglar bo'limi.** Har xil turdagi hot doglar mavjud.",
          parse_mode: "Markdown",
          // Instagram Inline Tugmasi qo'shildi
          reply_markup: {
            inline_keyboard: [
              [{ text: "📸 Instagram orqali ko'rish", url: INSTAGRAM_URL }],
            ],
          },
        });
        return;

      case "Kartoshka Fri 🍟":
        await bot.sendPhoto(chatId, IMAGE_PATHS.FRI, {
          caption:
            "🍟 **Kartoshka Fri bo'limi.** Kichik, o'rta, katta porsiyalar.",
          parse_mode: "Markdown",
          // Instagram Inline Tugmasi qo'shildi
          reply_markup: {
            inline_keyboard: [
              [{ text: "📸 Instagram orqali ko'rish", url: INSTAGRAM_URL }],
            ],
          },
        });
        return;

      case "🔙 Asosiy Menyuga Qaytish":
        sendReplyKeyboard(chatId, "Asosiy menyuga qaytdik. Birini tanlang:");
        return;

      default:
        // Agar tanish buyruq yoki menyu tugmasi bo'lmasa, pastga tushib boshqa logikalarni tekshiradi
        break;
    }
    // --- REPLY KEYBOARD TUGMALARIGA JAVOB BERISH MANTIQI TUGADI ---

    // Admin only commands
    if (isAdmin(fromId)) {
      // /users -> statistikalar
      if (text === "/users") {
        const total = Object.keys(users).length;
        const active = Object.values(users).filter(
          (u) =>
            new Date(u.last_seen) > new Date(Date.now() - 30 * 24 * 3600 * 1000)
        ).length;
        const msgText = `📊 Foydalanuvchilar statistikasi:\nJami: ${total}\nOxirgi 30 kunda aktív: ${active}`;
        bot.sendMessage(chatId, msgText);
        return;
      }

      // !schedule command
      if (text.startsWith("!schedule ")) {
        await handleScheduleCommand(chatId, text, msg);
        return;
      }

      // Send example inline (old functionality for inline buttons)
      if (text === "/inline") {
        sendExampleInline(chatId);
        return;
      }

      // ADMIN reply by ID: @@123456789
      const idMatch = text.match(/@@(\d{5,})\b/);
      if (idMatch) {
        const targetId = idMatch[1];
        const msgToSend =
          text.replace(`@@${targetId}`, "").trim() || "(Admindan xabar)";
        try {
          if (msg.photo || msg.video || msg.document) {
            // if admin included media, forward message instead
            await bot.forwardMessage(targetId, chatId, msg.message_id);
          } else {
            await bot.sendMessage(
              targetId,
              `💼 *Admin javobi:*\n${msgToSend}`,
              { parse_mode: "Markdown" }
            );
          }
          bot.sendMessage(chatId, `📤 Xabar ID ${targetId} ga yuborildi.`);
        } catch (err) {
          bot.sendMessage(
            chatId,
            `❗ Xatolik: foydalanuvchi topilmadi yoki block qilgan. ${err.message}`
          );
        }
        return;
      }

      // ADMIN reply by username: @username (first matched)
      const unameMatch = text.match(/@([A-Za-z0-9_]+)\b/);
      if (unameMatch) {
        const uname = unameMatch[1];
        const user = Object.values(users).find(
          (u) => u.username && u.username.toLowerCase() === uname.toLowerCase()
        );
        if (user) {
          const msgToSend =
            text.replace(`@${uname}`, "").trim() || "(Admindan xabar)";
          try {
            if (msg.photo || msg.video || msg.document) {
              await bot.forwardMessage(user.id, chatId, msg.message_id);
            } else {
              await bot.sendMessage(
                user.id,
                `💼 *Admin javobi:*\n${msgToSend}`,
                { parse_mode: "Markdown" }
              );
            }
            bot.sendMessage(chatId, `📬 Xabar @${uname} ga yuborildi.`);
          } catch (err) {
            bot.sendMessage(chatId, `❗ Xatolik: ${err.message}`);
          }
          return;
        } else {
          // If no matching username found and admin sent only text without @ usage, treat as broadcast
          // but admin probably expected user not found
          bot.sendMessage(chatId, `⚠️ Username @${uname} topilmadi.`);
          return;
        }
      }

      // E'LON MANTIQI: FAQAT MEDIA YOKI () QAVSLI MATNLAR UCHUN

      // 1. Media yuborilsa, e'lon qilinadi
      if (msg.photo || msg.video || msg.document || msg.audio) {
        await broadcastFromAdmin(chatId, msg);
        return;
      }

      // 2. Qavs ichidagi matn yuborilsa, e'lon qilinadi
      const broadcastMatch = text.match(/\((.*?)\)/s); // Matnni () ichida qidirish
      if (broadcastMatch) {
        const broadcastText = broadcastMatch[1].trim();

        if (broadcastText.length > 0) {
          // Vaqtinchalik msg obyektini yaratish
          const tempMsg = { text: broadcastText, message_id: msg.message_id };

          await broadcastFromAdmin(chatId, tempMsg);
          return;
        }
      }

      // Agar admin oddiy matn yuborsa (qavssiz, buyruqsiz va maxsus belgilarsiz), bu qismda hech narsa bajarilmaydi.
    }

    // Non-admin users: check for FAQ keywords (auto-reply)
    const lowered = text.toLowerCase();
    for (const item of FAQ) {
      for (const k of item.keys) {
        if (lowered.includes(k)) {
          bot.sendMessage(chatId, item.resp);
          return;
        }
      }
    }

    // If user sends "buttons" keyword, show reply keyboard
    if (
      lowered.includes("tugma") ||
      lowered.includes("button") ||
      lowered.includes("menu")
    ) {
      sendReplyKeyboard(chatId); // Asosiy menyu
      return;
    }

    // Default reply to user: accept message and forward to admins
    // Notify admins with message details and quick reply hints
    for (const admin of ADMINS) {
      try {
        await bot.sendMessage(
          admin,
          `📩 Yangi xabar!\n👤 ${
            msg.from.first_name || ""
          }\n🆔 ID: ${chatId}\n🌐 Username: @${
            msg.from.username || "mavjud emas"
          }\n✉️ ${
            text || "(media/xabar)"
          }\n\nJavob:\n• ID orqali: @@${chatId}\n• Username orqali: @${
            msg.from.username || "mavjud emas"
          }`,
          { parse_mode: "Markdown" }
        );
        // if message contains media, also forward one of the admins to see it
        if (msg.photo || msg.video || msg.document || msg.audio) {
          await bot.forwardMessage(admin, chatId, msg.message_id);
        }
      } catch (err) {
        // ignore
      }
    }

    // Acknowledge user
    await bot.sendMessage(
      chatId,
      "📥 Murojaatingiz qabul qilindi! Tez orada adminlar javob beradi."
    );
  } catch (err) {
    console.error("Message handler error:", err);
  }
});

// Callback query (inline buttons) handler
bot.on("callback_query", async (cb) => {
  try {
    const data = cb.data;
    const from = cb.from;
    if (data === "action_register") {
      await bot.answerCallbackQuery(cb.id, {
        text: "Siz ro'yxatdan o'tdingiz!",
      });
      // do registration action or store intent
      addUser({ chat: { id: from.id }, from });
      bot.sendMessage(
        from.id,
        "✅ Ro'yxatdan o'tishingiz qabul qilindi. Tez orada admin bilan bog'lanamiz."
      );
    } else {
      await bot.answerCallbackQuery(cb.id, { text: "Tugma bosildi." });
    }
  } catch (err) {
    // ignore
  }
});

// Graceful shutdown save
process.on("SIGINT", () => {
  console.log("SIGINT, saqlanmoqda...");
  saveJSON(USERS_FILE, users);
  saveJSON(SCHEDULE_FILE, schedules);
  process.exit();
});
process.on("SIGTERM", () => {
  console.log("SIGTERM, saqlanmoqda...");
  saveJSON(USERS_FILE, users);
  saveJSON(SCHEDULE_FILE, schedules);
  process.exit();
});

console.log("Bot ishga tushdi...");
