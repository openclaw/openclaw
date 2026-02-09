---
summary: "ایجنٹس، لفافوں، اور پرامپٹس کے لیے ٹائم زون کی ہینڈلنگ"
read_when:
  - آپ کو یہ سمجھنے کی ضرورت ہو کہ ماڈل کے لیے ٹائم اسٹیمپس کیسے نارملائز کیے جاتے ہیں
  - سسٹم پرامپٹس کے لیے صارف کے ٹائم زون کی کنفیگریشن
title: "ٹائم زونز"
---

# ٹائم زونز

OpenClaw ٹائم اسٹیمپس کو معیاری بناتا ہے تاکہ ماڈل کو **ایک واحد حوالہ وقت** نظر آئے۔

## میسج لفافے (بطورِ طے شدہ لوکل)

ان باؤنڈ پیغامات کو اس طرح کے لفافے میں لپیٹا جاتا ہے:

```
[Provider ... 2026-01-05 16:26 PST] message text
```

لفافے میں ٹائم اسٹیمپ **بطورِ طے شدہ ہوسٹ-لوکل** ہوتا ہے، منٹ کی درستی کے ساتھ۔

آپ اسے اس کے ذریعے اووررائیڈ کر سکتے ہیں:

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA timezone
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` UTC استعمال کرتا ہے۔
- `envelopeTimezone: "user"` `agents.defaults.userTimezone` استعمال کرتا ہے (ہوسٹ ٹائم زون پر واپس آتا ہے)۔
- ایک مقررہ آفسیٹ کے لیے واضح IANA ٹائم زون استعمال کریں (مثلاً، `"Europe/Vienna"`)۔
- `envelopeTimestamp: "off"` لفافے کے ہیڈرز سے مطلق ٹائم اسٹیمپس ہٹا دیتا ہے۔
- `envelopeElapsed: "off"` گزرا ہوا وقت لاحقے ہٹا دیتا ہے ( `+2m` طرز)۔

### مثالیں

**لوکل (بطورِ طے شدہ):**

```
[Signal Alice +1555 2026-01-18 00:19 PST] hello
```

**مقررہ ٹائم زون:**

```
[Signal Alice +1555 2026-01-18 06:19 GMT+1] hello
```

**گزرا ہوا وقت:**

```
[Signal Alice +1555 +2m 2026-01-18T05:19Z] follow-up
```

## ٹول پے لوڈز (خام فراہم کنندہ ڈیٹا + نارملائزڈ فیلڈز)

24. ٹول کالز (`channels.discord.readMessages`, `channels.slack.readMessages`, وغیرہ) 25. **خام provider timestamps** واپس کرتی ہیں۔
25. ہم یکسانیت کے لیے normalized فیلڈز بھی منسلک کرتے ہیں:

- `timestampMs` (UTC ایپوک ملی سیکنڈز)
- `timestampUtc` (ISO 8601 UTC اسٹرنگ)

خام فراہم کنندہ فیلڈز محفوظ رکھی جاتی ہیں۔

## سسٹم پرامپٹ کے لیے صارف کا ٹائم زون

27. ماڈل کو صارف کا مقامی ٹائم زون بتانے کے لیے `agents.defaults.userTimezone` سیٹ کریں۔ 45. اگر یہ سیٹ نہ ہو، تو OpenClaw **رن ٹائم پر ہوسٹ ٹائم زون** حل کرتا ہے (کوئی کنفیگ رائٹ نہیں)۔

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

سسٹم پرامپٹ میں شامل ہوتا ہے:

- `Current Date & Time` سیکشن، جس میں لوکل وقت اور ٹائم زون شامل ہیں
- `Time format: 12-hour` یا `24-hour`

آپ پرامپٹ کے فارمیٹ کو `agents.defaults.timeFormat` کے ذریعے کنٹرول کر سکتے ہیں (`auto` | `12` | `24`)۔

مکمل رویّے اور مثالوں کے لیے [Date & Time](/date-time) دیکھیں۔
