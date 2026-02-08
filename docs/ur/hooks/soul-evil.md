---
summary: "SOUL Evil ہُک (SOUL.md کو SOUL_EVIL.md کے ساتھ تبدیل کرنا)"
read_when:
  - آپ SOUL Evil ہُک کو فعال یا اس کی ٹیوننگ کرنا چاہتے ہیں
  - آپ purge ونڈو یا رینڈم-چانس persona سوئچ چاہتے ہیں
title: "SOUL Evil ہُک"
x-i18n:
  source_path: hooks/soul-evil.md
  source_hash: 32aba100712317d1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:17Z
---

# SOUL Evil ہُک

SOUL Evil ہُک purge ونڈو کے دوران یا رینڈم امکان کے ذریعے **انجیکٹ کیے گئے** `SOUL.md` مواد کو `SOUL_EVIL.md` کے ساتھ تبدیل کر دیتا ہے۔ یہ ڈسک پر موجود فائلوں میں **کوئی** تبدیلی نہیں کرتا۔

## یہ کیسے کام کرتا ہے

جب `agent:bootstrap` چلتا ہے، تو یہ ہُک سسٹم پرامپٹ تیار ہونے سے پہلے میموری میں موجود `SOUL.md` مواد کو بدل سکتا ہے۔ اگر `SOUL_EVIL.md` موجود نہ ہو یا خالی ہو، تو OpenClaw ایک وارننگ لاگ کرتا ہے اور معمول کا `SOUL.md` برقرار رکھتا ہے۔

سب-ایجنٹ رنز میں اپنے بوٹسٹریپ فائلز میں `SOUL.md` شامل نہیں ہوتا، اس لیے اس ہُک کا سب-ایجنٹس پر کوئی اثر نہیں پڑتا۔

## فعال کریں

```bash
openclaw hooks enable soul-evil
```

پھر کنفیگ سیٹ کریں:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

ایجنٹ ورک اسپیس روٹ میں `SOUL_EVIL.md` بنائیں (بالکل `SOUL.md` کے ساتھ)۔

## اختیارات

- `file` (string): متبادل SOUL فائل نام (بطورِ طے شدہ: `SOUL_EVIL.md`)
- `chance` (number 0–1): ہر رن میں `SOUL_EVIL.md` استعمال کرنے کا رینڈم امکان
- `purge.at` (HH:mm): روزانہ purge شروع ہونے کا وقت (24-گھنٹے گھڑی)
- `purge.duration` (duration): ونڈو کی مدت (مثلاً `30s`، `10m`، `1h`)

**ترجیح:** purge ونڈو کو رینڈم امکان پر فوقیت حاصل ہے۔

**ٹائم زون:** اگر `agents.defaults.userTimezone` سیٹ ہو تو اسے استعمال کیا جاتا ہے؛ بصورتِ دیگر ہوسٹ ٹائم زون۔

## نوٹس

- ڈسک پر کوئی فائل لکھی یا ترمیم نہیں کی جاتی۔
- اگر بوٹسٹریپ فہرست میں `SOUL.md` شامل نہ ہو تو ہُک کچھ نہیں کرتا۔

## یہ بھی دیکھیں

- [Hooks](/automation/hooks)
