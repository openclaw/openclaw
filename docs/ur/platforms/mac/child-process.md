---
summary: "macOS پر Gateway کی لائف سائیکل (launchd)"
read_when:
  - Gateway کی لائف سائیکل کے ساتھ mac ایپ کو یکجا کرتے وقت
title: "Gateway کی لائف سائیکل"
x-i18n:
  source_path: platforms/mac/child-process.md
  source_hash: 9b910f574b723bc1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:28Z
---

# macOS پر Gateway کی لائف سائیکل

macOS ایپ بطورِ طے شدہ **launchd کے ذریعے Gateway کو منیج کرتی ہے** اور Gateway کو چائلڈ پروسیس کے طور پر شروع نہیں کرتی۔
یہ پہلے کنفیگر کیے گئے پورٹ پر پہلے سے چلتے ہوئے Gateway سے منسلک ہونے کی کوشش کرتی ہے؛ اگر کوئی دستیاب نہ ہو تو
یہ بیرونی `openclaw` CLI کے ذریعے launchd سروس کو فعال کرتی ہے (کوئی ایمبیڈڈ رن ٹائم نہیں)۔
اس سے لاگ اِن پر قابلِ اعتماد آٹو‑اسٹارٹ اور کریش کی صورت میں ری اسٹارٹ ملتا ہے۔

چائلڈ‑پروسیس موڈ (ایپ کے ذریعے براہِ راست Gateway چلانا) اس وقت **استعمال میں نہیں** ہے۔
اگر آپ کو UI کے ساتھ زیادہ قریبی ربط درکار ہو تو Gateway کو ٹرمینل میں دستی طور پر چلائیں۔

## بطورِ طے شدہ رویہ (launchd)

- ایپ فی‑یوزر LaunchAgent انسٹال کرتی ہے جس کا لیبل `bot.molt.gateway` ہوتا ہے
  (یا `bot.molt.<profile>` جب `--profile`/`OPENCLAW_PROFILE` استعمال کیا جائے؛ لیگیسی `com.openclaw.*` بھی سپورٹڈ ہے)۔
- جب Local موڈ فعال ہو، ایپ اس بات کو یقینی بناتی ہے کہ LaunchAgent لوڈ ہو اور
  ضرورت پڑنے پر Gateway شروع کرے۔
- لاگز launchd کے gateway لاگ پاتھ پر لکھے جاتے ہیں (Debug Settings میں نظر آتے ہیں)۔

عام کمانڈز:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

نامی پروفائل چلانے پر لیبل کو `bot.molt.<profile>` سے تبدیل کریں۔

## غیر دستخط شدہ dev بلڈز

`scripts/restart-mac.sh --no-sign` تیز رفتار لوکل بلڈز کے لیے ہے جب آپ کے پاس
سائننگ کیز نہ ہوں۔ launchd کو غیر دستخط شدہ relay بائنری کی طرف اشارہ کرنے سے روکنے کے لیے یہ:

- `~/.openclaw/disable-launchagent` لکھتا ہے۔

`scripts/restart-mac.sh` کی سائن شدہ رنز اگر یہ مارکر موجود ہو تو اس اووررائیڈ کو صاف کر دیتی ہیں۔
دستی طور پر ری سیٹ کرنے کے لیے:

```bash
rm ~/.openclaw/disable-launchagent
```

## صرف‑اٹیچ موڈ

macOS ایپ کو **کبھی بھی launchd انسٹال یا منیج نہ کرنے** پر مجبور کرنے کے لیے اسے
`--attach-only` (یا `--no-launchd`) کے ساتھ لانچ کریں۔
یہ `~/.openclaw/disable-launchagent` سیٹ کرتا ہے، لہٰذا ایپ صرف پہلے سے چلتے ہوئے Gateway سے منسلک ہوتی ہے۔
آپ Debug Settings میں بھی یہی رویہ ٹوگل کر سکتے ہیں۔

## ریموٹ موڈ

ریموٹ موڈ کبھی لوکل Gateway شروع نہیں کرتا۔
ایپ ریموٹ ہوسٹ تک SSH سرنگ استعمال کرتی ہے اور اسی سرنگ کے ذریعے کنیکٹ ہوتی ہے۔

## ہم launchd کو کیوں ترجیح دیتے ہیں

- لاگ اِن پر آٹو‑اسٹارٹ۔
- بلٹ‑اِن ری اسٹارٹ/KeepAlive سیمینٹکس۔
- قابلِ پیش گوئی لاگز اور نگرانی۔

اگر کبھی حقیقی چائلڈ‑پروسیس موڈ دوبارہ درکار ہو، تو اسے ایک علیحدہ، واضح dev‑صرف موڈ کے طور پر دستاویزی شکل دی جانی چاہیے۔
