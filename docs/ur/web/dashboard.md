---
summary: "Gateway ڈیش بورڈ (کنٹرول UI) تک رسائی اور تصدیق"
read_when:
  - ڈیش بورڈ کی تصدیق یا ایکسپوژر موڈز تبدیل کرتے وقت
title: "ڈیش بورڈ"
x-i18n:
  source_path: web/dashboard.md
  source_hash: e4fc372b72f030f9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:46Z
---

# ڈیش بورڈ (کنٹرول UI)

Gateway ڈیش بورڈ براؤزر پر مبنی کنٹرول UI ہے جو بطورِ طے شدہ `/` پر فراہم کیا جاتا ہے
(`gateway.controlUi.basePath` کے ذریعے اووررائیڈ کریں)۔

فوری کھولیں (لوکل Gateway):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (یا [http://localhost:18789/](http://localhost:18789/))

اہم حوالہ جات:

- استعمال اور UI صلاحیتوں کے لیے [کنٹرول UI](/web/control-ui)۔
- Serve/Funnel آٹومیشن کے لیے [Tailscale](/gateway/tailscale)۔
- بائنڈ موڈز اور سکیورٹی نوٹس کے لیے [ویب سرفیسز](/web)۔

تصدیق WebSocket ہینڈشیک پر `connect.params.auth` (ٹوکن یا پاس ورڈ) کے ذریعے نافذ کی جاتی ہے۔
[Gateway کنفیگریشن](/gateway/configuration) میں `gateway.auth` دیکھیں۔

سکیورٹی نوٹ: کنٹرول UI ایک **ایڈمن سرفیس** ہے (چیٹ، کنفیگ، ایگزیک منظوریات)۔
اسے عوامی طور پر ایکسپوز نہ کریں۔ UI پہلی لوڈ کے بعد ٹوکن کو `localStorage` میں محفوظ کرتی ہے۔
localhost، Tailscale Serve، یا SSH سرنگ کو ترجیح دیں۔

## فاسٹ پاتھ (سفارش کردہ)

- آن بورڈنگ کے بعد، CLI خودکار طور پر ڈیش بورڈ کھول دیتا ہے اور ایک صاف (غیر ٹوکنائزڈ) لنک پرنٹ کرتا ہے۔
- کسی بھی وقت دوبارہ کھولیں: `openclaw dashboard` (لنک کاپی کرتا ہے، ممکن ہو تو براؤزر کھولتا ہے، اور اگر ہیڈلیس ہو تو SSH ہِنٹ دکھاتا ہے)۔
- اگر UI تصدیق کا مطالبہ کرے، تو `gateway.auth.token` (یا `OPENCLAW_GATEWAY_TOKEN`) سے ٹوکن لے کر کنٹرول UI سیٹنگز میں پیسٹ کریں۔

## ٹوکن کی بنیادی باتیں (لوکل بمقابلہ ریموٹ)

- **لوکل ہوسٹ**: `http://127.0.0.1:18789/` کھولیں۔
- **ٹوکن سورس**: `gateway.auth.token` (یا `OPENCLAW_GATEWAY_TOKEN`)؛ کنیکٹ ہونے کے بعد UI ایک کاپی localStorage میں محفوظ کر لیتی ہے۔
- **لوکل ہوسٹ نہیں**: Tailscale Serve استعمال کریں (اگر `gateway.auth.allowTailscale: true` ہو تو ٹوکن کے بغیر)، ٹیل نیٹ بائنڈ ٹوکن کے ساتھ، یا SSH سرنگ۔ [ویب سرفیسز](/web) دیکھیں۔

## اگر آپ کو “unauthorized” / 1008 نظر آئے

- یقینی بنائیں کہ gateway قابلِ رسائی ہے (لوکل: `openclaw status`؛ ریموٹ: SSH سرنگ `ssh -N -L 18789:127.0.0.1:18789 user@host` پھر `http://127.0.0.1:18789/` کھولیں)۔
- gateway ہوسٹ سے ٹوکن حاصل کریں: `openclaw config get gateway.auth.token` (یا ایک نیا بنائیں: `openclaw doctor --generate-gateway-token`)۔
- ڈیش بورڈ سیٹنگز میں، ٹوکن کو auth فیلڈ میں پیسٹ کریں، پھر کنیکٹ کریں۔
