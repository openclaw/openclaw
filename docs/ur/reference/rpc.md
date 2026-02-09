---
summary: "بیرونی CLIز (signal-cli، legacy imsg) کے لیے RPC اڈاپٹرز اور gateway پیٹرنز"
read_when:
  - بیرونی CLI انضمامات شامل یا تبدیل کرتے وقت
  - RPC اڈاپٹرز (signal-cli، imsg) کی خرابیوں کا ازالہ کرتے وقت
title: "RPC اڈاپٹرز"
---

# RPC اڈاپٹرز

OpenClaw integrates external CLIs via JSON-RPC. Two patterns are used today.

## پیٹرن A: HTTP ڈیمَن (signal-cli)

- `signal-cli` ایک ڈیمَن کے طور پر HTTP پر JSON-RPC کے ساتھ چلتا ہے۔
- ایونٹ اسٹریم SSE (`/api/v1/events`) ہے۔
- ہیلتھ پروب: `/api/v1/check`۔
- جب `channels.signal.autoStart=true` ہو تو OpenClaw لائف سائیکل کا مالک ہوتا ہے۔

سیٹ اپ اور اینڈپوائنٹس کے لیے [Signal](/channels/signal) دیکھیں۔

## پیٹرن B: stdio چائلڈ پروسیس (legacy: imsg)

> **نوٹ:** نئے iMessage سیٹ اپس کے لیے اس کے بجائے [BlueBubbles](/channels/bluebubbles) استعمال کریں۔

- OpenClaw `imsg rpc` کو چائلڈ پروسیس کے طور پر اسپان کرتا ہے (legacy iMessage انضمام)۔
- JSON-RPC stdin/stdout پر لائن-ڈلیمٹڈ ہوتا ہے (ہر لائن میں ایک JSON آبجیکٹ)۔
- کوئی TCP پورٹ نہیں، کسی ڈیمَن کی ضرورت نہیں۔

استعمال ہونے والے بنیادی طریقے:

- `watch.subscribe` → نوٹیفیکیشنز (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (پروب/تشخیص)

legacy سیٹ اپ اور ایڈریسنگ کے لیے [iMessage](/channels/imessage) دیکھیں (`chat_id` کو ترجیح دی جاتی ہے)۔

## اڈاپٹر رہنما اصول

- Gateway (گیٹ وے) پروسیس کا مالک ہوتا ہے (اسٹارٹ/اسٹاپ فراہم کنندہ کے لائف سائیکل سے منسلک)۔
- RPC کلائنٹس کو مضبوط رکھیں: ٹائم آؤٹس، ایگزٹ پر ری اسٹارٹ۔
- ڈسپلے اسٹرنگز کے بجائے مستحکم IDs کو ترجیح دیں (مثلاً `chat_id`)۔
