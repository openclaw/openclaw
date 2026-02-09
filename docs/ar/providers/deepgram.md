---
summary: "تفريغ الصوت من Deepgram للملاحظات الصوتية الواردة"
read_when:
  - تريد استخدام تحويل الكلام إلى نص من Deepgram للمرفقات الصوتية
  - تحتاج إلى مثال تهيئة سريع لـ Deepgram
title: "Deepgram"
---

# Deepgram (تفريغ الصوت)

Deepgram هو واجهة برمجة تطبيقات لتحويل الكلام إلى نص. في OpenClaw يُستخدم من أجل **تفريغ الصوت/الملاحظات الصوتية الواردة**
عبر `tools.media.audio`.

عند تمكينه، يقوم OpenClaw برفع ملف الصوت إلى Deepgram وحقن النص المُفرَّغ
في خط أنابيب الرد (`{{Transcript}}` + كتلة `[Audio]`). هذا **ليس بثًا مباشرًا**؛
إذ يستخدم نقطة نهاية التفريغ للصوت المسجَّل مسبقًا.

الموقع: [https://deepgram.com](https://deepgram.com)  
التوثيق: [https://developers.deepgram.com](https://developers.deepgram.com)

## البدء السريع

1. اضبط مفتاح واجهة برمجة التطبيقات الخاص بك:

```
DEEPGRAM_API_KEY=dg_...
```

2. تمكين المزود:

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

## الخيارات

- `model`: معرّف نموذج Deepgram (الافتراضي: `nova-3`)
- `language`: تلميح اللغة (اختياري)
- `tools.media.audio.providerOptions.deepgram.detect_language`: تمكين اكتشاف اللغة (اختياري)
- `tools.media.audio.providerOptions.deepgram.punctuate`: تمكين علامات الترقيم (اختياري)
- `tools.media.audio.providerOptions.deepgram.smart_format`: تمكين التنسيق الذكي (اختياري)

مثال مع اللغة:

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

مثال مع خيارات Deepgram:

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

## ملاحظات

- تتبع المصادقة ترتيب مصادقة الموفّرين القياسي؛ ويُعد `DEEPGRAM_API_KEY` المسار الأبسط.
- يمكن تجاوز نقاط النهاية أو الرؤوس باستخدام `tools.media.audio.baseUrl` و `tools.media.audio.headers` عند استخدام وكيل.
- يتبع الإخراج القواعد الصوتية نفسها المعمول بها لدى الموفّرين الآخرين (حدود الحجم، مهلات الانتظار، وحقن النص المُفرَّغ).
