---
summary: "ان باؤنڈ وائس نوٹس کے لیے Deepgram ٹرانسکرپشن"
read_when:
  - آپ آڈیو اٹیچمنٹس کے لیے Deepgram اسپیچ ٹو ٹیکسٹ چاہتے ہیں
  - آپ کو Deepgram کنفیگ کی ایک فوری مثال درکار ہے
title: "Deepgram"
x-i18n:
  source_path: providers/deepgram.md
  source_hash: dabd1f6942c339fb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:32Z
---

# Deepgram (آڈیو ٹرانسکرپشن)

Deepgram ایک اسپیچ ٹو ٹیکسٹ API ہے۔ OpenClaw میں اسے **ان باؤنڈ آڈیو/وائس نوٹ
ٹرانسکرپشن** کے لیے `tools.media.audio` کے ذریعے استعمال کیا جاتا ہے۔

جب فعال کیا جائے، OpenClaw آڈیو فائل Deepgram پر اپ لوڈ کرتا ہے اور ٹرانسکرپٹ
کو جواب کی پائپ لائن میں داخل کرتا ہے (`{{Transcript}}` + `[Audio]` بلاک)۔ یہ **اسٹریمنگ نہیں** ہے؛
یہ پہلے سے ریکارڈ شدہ ٹرانسکرپشن اینڈپوائنٹ استعمال کرتا ہے۔

ویب سائٹ: [https://deepgram.com](https://deepgram.com)  
دستاویزات: [https://developers.deepgram.com](https://developers.deepgram.com)

## فوری آغاز

1. اپنی API کلید سیٹ کریں:

```
DEEPGRAM_API_KEY=dg_...
```

2. فراہم کنندہ فعال کریں:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## اختیارات

- `model`: Deepgram ماڈل آئی ڈی (بطورِ طے شدہ: `nova-3`)
- `language`: زبان کا اشارہ (اختیاری)
- `tools.media.audio.providerOptions.deepgram.detect_language`: زبان کی شناخت فعال کریں (اختیاری)
- `tools.media.audio.providerOptions.deepgram.punctuate`: رموزِ اوقاف فعال کریں (اختیاری)
- `tools.media.audio.providerOptions.deepgram.smart_format`: اسمارٹ فارمیٹنگ فعال کریں (اختیاری)

زبان کے ساتھ مثال:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3", language: "en" }],
      },
    },
  },
}
```

Deepgram اختیارات کے ساتھ مثال:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        providerOptions: {
          deepgram: {
            detect_language: true,
            punctuate: true,
            smart_format: true,
          },
        },
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## نوٹس

- تصدیق معیاری فراہم کنندہ کی تصدیقی ترتیب کی پیروی کرتی ہے؛ `DEEPGRAM_API_KEY` سب سے سادہ راستہ ہے۔
- پروکسی استعمال کرتے وقت `tools.media.audio.baseUrl` اور `tools.media.audio.headers` کے ذریعے اینڈپوائنٹس یا ہیڈرز اووررائیڈ کریں۔
- آؤٹ پٹ دیگر فراہم کنندگان کی طرح ہی آڈیو قواعد کی پیروی کرتا ہے (سائز کی حدیں، ٹائم آؤٹس، ٹرانسکرپٹ انجیکشن)۔
