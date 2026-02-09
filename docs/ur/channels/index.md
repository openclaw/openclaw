---
summary: "میسجنگ پلیٹ فارمز جن سے OpenClaw منسلک ہو سکتا ہے"
read_when:
  - آپ OpenClaw کے لیے چیٹ چینل منتخب کرنا چاہتے ہوں
  - آپ کو معاون میسجنگ پلیٹ فارمز کا فوری جائزہ درکار ہو
title: "چیٹ چینلز"
---

# چیٹ چینلز

OpenClaw can talk to you on any chat app you already use. Each channel connects via the Gateway.
Text is supported everywhere; media and reactions vary by channel.

## معاون چینلز

- [WhatsApp](/channels/whatsapp) — سب سے زیادہ مقبول؛ Baileys استعمال کرتا ہے اور QR جوڑی بنانے کی ضرورت ہوتی ہے۔
- [Telegram](/channels/telegram) — grammY کے ذریعے Bot API؛ گروپس کی معاونت۔
- [Discord](/channels/discord) — Discord Bot API + Gateway؛ سرورز، چینلز، اور DMs کی معاونت۔
- [Slack](/channels/slack) — Bolt SDK؛ ورک اسپیس ایپس۔
- [Feishu](/channels/feishu) — WebSocket کے ذریعے Feishu/Lark بوٹ (پلگ اِن، الگ سے انسٹال کیا جاتا ہے)۔
- [Google Chat](/channels/googlechat) — HTTP ویب ہُک کے ذریعے Google Chat API ایپ۔
- [Mattermost](/channels/mattermost) — Bot API + WebSocket؛ چینلز، گروپس، DMs (پلگ اِن، الگ سے انسٹال کیا جاتا ہے)۔
- [Signal](/channels/signal) — signal-cli؛ رازداری پر مرکوز۔
- [BlueBubbles](/channels/bluebubbles) — **iMessage کے لیے سفارش کردہ**؛ BlueBubbles macOS سرور REST API استعمال کرتا ہے اور مکمل فیچر سپورٹ فراہم کرتا ہے (ترمیم، اَن سینڈ، ایفیکٹس، ری ایکشنز، گروپ مینجمنٹ — macOS 26 Tahoe پر ترمیم فی الحال خراب ہے)۔
- [iMessage (legacy)](/channels/imessage) — imsg CLI کے ذریعے پرانا macOS انضمام (متروک؛ نئی سیٹ اپس کے لیے BlueBubbles استعمال کریں)۔
- [Microsoft Teams](/channels/msteams) — Bot Framework؛ انٹرپرائز سپورٹ (پلگ اِن، الگ سے انسٹال کیا جاتا ہے)۔
- [LINE](/channels/line) — LINE Messaging API بوٹ (پلگ اِن، الگ سے انسٹال کیا جاتا ہے)۔
- [Nextcloud Talk](/channels/nextcloud-talk) — Nextcloud Talk کے ذریعے خود میزبانی شدہ چیٹ (پلگ اِن، الگ سے انسٹال کیا جاتا ہے)۔
- [Matrix](/channels/matrix) — Matrix پروٹوکول (پلگ اِن، الگ سے انسٹال کیا جاتا ہے)۔
- [Nostr](/channels/nostr) — NIP-04 کے ذریعے غیر مرکزی DMs (پلگ اِن، الگ سے انسٹال کیا جاتا ہے)۔
- [Tlon](/channels/tlon) — Urbit پر مبنی میسنجر (پلگ اِن، الگ سے انسٹال کیا جاتا ہے)۔
- [Twitch](/channels/twitch) — IRC کنکشن کے ذریعے Twitch چیٹ (پلگ اِن، الگ سے انسٹال کیا جاتا ہے)۔
- [Zalo](/channels/zalo) — Zalo Bot API؛ ویتنام کا مقبول میسنجر (پلگ اِن، الگ سے انسٹال کیا جاتا ہے)۔
- [Zalo Personal](/channels/zalouser) — QR لاگ اِن کے ذریعے Zalo ذاتی اکاؤنٹ (پلگ اِن، الگ سے انسٹال کیا جاتا ہے)۔
- [WebChat](/web/webchat) — WebSocket کے ذریعے Gateway WebChat UI۔

## نوٹس

- چینلز بیک وقت چل سکتے ہیں؛ متعدد کنفیگر کریں اور OpenClaw ہر چیٹ کے مطابق روٹنگ کرے گا۔
- Fastest setup is usually **Telegram** (simple bot token). WhatsApp requires QR pairing and
  stores more state on disk.
- گروپ کا رویہ چینل کے لحاظ سے مختلف ہوتا ہے؛ دیکھیں [Groups](/channels/groups)۔
- حفاظت کے لیے DM جوڑی بنانا اور اجازت فہرستیں نافذ کی جاتی ہیں؛ دیکھیں [Security](/gateway/security)۔
- Telegram کے اندرونی نکات: [grammY notes](/channels/grammy)۔
- خرابیوں کا ازالہ: [Channel troubleshooting](/channels/troubleshooting)۔
- ماڈل فراہم کنندگان کی دستاویزات الگ ہیں؛ دیکھیں [Model Providers](/providers/models)۔
