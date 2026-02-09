---
summary: "macOS پر Gateway رَن ٹائم (بیرونی launchd سروس)"
read_when:
  - OpenClaw.app کی پیکیجنگ
  - macOS Gateway launchd سروس کی ڈیبگنگ
  - macOS کے لیے gateway CLI کی تنصیب
title: "macOS پر Gateway"
---

# macOS پر Gateway (بیرونی launchd)

OpenClaw.app اب Node/Bun یا Gateway رن ٹائم کو بنڈل نہیں کرتا۔ macOS ایپ
ایک **بیرونی** `openclaw` CLI انسٹال کی توقع کرتی ہے، Gateway کو
چائلڈ پروسیس کے طور پر شروع نہیں کرتی، اور Gateway کو چلتا رکھنے کے لیے
فی صارف launchd سروس کو منیج کرتی ہے (یا اگر کوئی مقامی Gateway پہلے سے
چل رہا ہو تو اس سے منسلک ہو جاتی ہے)۔

## CLI انسٹال کریں (لوکل موڈ کے لیے لازم)

آپ کو Mac پر Node 22+ درکار ہے، پھر `openclaw` کو عالمی طور پر انسٹال کریں:

```bash
npm install -g openclaw@<version>
```

macOS ایپ کا **Install CLI** بٹن npm/pnpm کے ذریعے یہی عمل چلاتا ہے (Gateway رَن ٹائم کے لیے bun کی سفارش نہیں کی جاتی)۔

## Launchd (Gateway بطور LaunchAgent)

Label:

- `bot.molt.gateway` (یا `bot.molt.<profile>``; legacy `com.openclaw.\*\` باقی رہ سکتا ہے)

Plist کی جگہ (فی صارف):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (یا `~/Library/LaunchAgents/bot.molt.<profile>`.plist\`)

Manager:

- لوکل موڈ میں LaunchAgent کی تنصیب/اپڈیٹ macOS ایپ کی ذمہ داری ہے۔
- CLI بھی اسے انسٹال کر سکتا ہے: `openclaw gateway install`۔

رویہ:

- “OpenClaw Active” LaunchAgent کو فعال/غیرفعال کرتا ہے۔
- ایپ بند کرنے سے Gateway **نہیں** رکتا (launchd اسے چلتا رکھتا ہے)۔
- اگر ترتیب شدہ پورٹ پر Gateway پہلے سے چل رہا ہو تو ایپ نیا شروع کرنے کے بجائے اسی سے منسلک ہو جاتی ہے۔

لاگنگ:

- launchd stdout/err: `/tmp/openclaw/openclaw-gateway.log`

## ورژن کی مطابقت

macOS ایپ Gateway کے ورژن کو اپنے ورژن کے ساتھ چیک کرتی ہے۔ اگر یہ
مطابقت نہ رکھتے ہوں تو ایپ کے ورژن کے مطابق گلوبل CLI کو اپڈیٹ کریں۔

## اسموک چیک

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

پھر:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
