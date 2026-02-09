---
summary: "كيفية تنزيل الصوت/الملاحظات الصوتية الواردة ونسخها وإدراجها في الردود"
read_when:
  - تغيير نسخ الصوت أو التعامل مع الوسائط
title: "الصوت والملاحظات الصوتية"
---

# الصوت / الملاحظات الصوتية — 2026-01-17

## ما الذي يعمل

- **فهم الوسائط (الصوت)**: إذا كان فهم الصوت مُمكّنًا (أو تم اكتشافه تلقائيًا)، يقوم OpenClaw بما يلي:
  1. يحدّد أول مرفق صوتي (مسار محلي أو URL) ويقوم بتنزيله إذا لزم الأمر.
  2. يفرض `maxBytes` قبل الإرسال إلى كل إدخال نموذج.
  3. يشغّل أول إدخال نموذج مؤهّل بالترتيب (موفّر أو CLI).
  4. إذا فشل أو تم تخطيه (الحجم/المهلة)، يحاول الإدخال التالي.
  5. عند النجاح، يستبدل `Body` بكتلة `[Audio]` ويعيّن `{{Transcript}}`.
- **تحليل الأوامر**: عند نجاح النسخ، يتم تعيين `CommandBody`/`RawBody` إلى النص المنسوخ بحيث تستمر أوامر الشرطة المائلة في العمل.
- **تسجيل مُفصّل**: في `--verbose`، نقوم بتسجيل وقت تشغيل النسخ ووقت استبدال النص.

## الاكتشاف التلقائي (الافتراضي)

إذا **لم تُكوّن النماذج** ولم يتم تعيين `tools.media.audio.enabled` إلى `false`،
يقوم OpenClaw بالاكتشاف التلقائي بالترتيب التالي ويتوقف عند أول خيار يعمل:

1. **واجهات CLI محلية** (إذا كانت مُثبّتة)
   - `sherpa-onnx-offline` (يتطلب `SHERPA_ONNX_MODEL_DIR` مع encoder/decoder/joiner/tokens)
   - `whisper-cli` (من `whisper-cpp`؛ يستخدم `WHISPER_CPP_MODEL` أو النموذج الصغير المضمّن)
   - `whisper` (واجهة Python CLI؛ تُنزّل النماذج تلقائيًا)
2. **Gemini CLI** (`gemini`) باستخدام `read_many_files`
3. **مفاتيح الموفّرين** (OpenAI → Groq → Deepgram → Google)

لتعطيل الاكتشاف التلقائي، عيّن `tools.media.audio.enabled: false`.
للتخصيص، عيّن `tools.media.audio.models`.
ملاحظة: اكتشاف الثنائيات يتم بأفضل جهد عبر macOS/Linux/Windows؛ تأكّد من وجود CLI على `PATH` (نقوم بتوسيع `~`)، أو عيّن نموذج CLI صريحًا بمسار أمر كامل.

## أمثلة التهيئة

### موفّر + احتياطي CLI (OpenAI + Whisper CLI)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
            timeoutSeconds: 45,
          },
        ],
      },
    },
  },
}
```

### موفّر فقط مع تقييد النطاق

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        scope: {
          default: "allow",
          rules: [{ action: "deny", match: { chatType: "group" } }],
        },
        models: [{ provider: "openai", model: "gpt-4o-mini-transcribe" }],
      },
    },
  },
}
```

### موفّر فقط (Deepgram)

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

## ملاحظات وحدود

- يتبع توثيق موفّر الخدمة ترتيب توثيق النموذج القياسي (ملفات تعريف المصادقة، متغيرات البيئة، `models.providers.*.apiKey`).
- يلتقط Deepgram `DEEPGRAM_API_KEY` عند استخدام `provider: "deepgram"`.
- تفاصيل إعداد Deepgram: [Deepgram (نسخ الصوت)](/providers/deepgram).
- يمكن لموفّري الصوت تجاوز `baseUrl` و`headers` و`providerOptions` عبر `tools.media.audio`.
- الحد الافتراضي للحجم هو 20MB (`tools.media.audio.maxBytes`). يتم تخطي الصوت الأكبر من الحد لذلك النموذج وتجربة الإدخال التالي.
- القيمة الافتراضية لـ `maxChars` للصوت **غير معيّنة** (نص كامل). عيّن `tools.media.audio.maxChars` أو `maxChars` لكل إدخال لتقليم الإخراج.
- الافتراضي التلقائي لـ OpenAI هو `gpt-4o-mini-transcribe`؛ عيّن `model: "gpt-4o-transcribe"` لدقة أعلى.
- استخدم `tools.media.audio.attachments` لمعالجة عدة ملاحظات صوتية (`mode: "all"` + `maxAttachments`).
- النص المنسوخ متاح للقوالب باسم `{{Transcript}}`.
- إخراج stdout لواجهة CLI محدود (5MB)؛ احرص على إبقاء إخراج CLI موجزًا.

## غوشا

- تستخدم قواعد النطاق مبدأ «أول تطابق يفوز». يتم تطبيع `chatType` إلى `direct` أو `group` أو `room`.
- تأكّد من أن واجهة CLI تنهي التنفيذ برمز خروج 0 وتطبع نصًا عاديًا؛ يحتاج JSON إلى تهيئة عبر `jq -r .text`.
- حافظ على مهلات زمنية معقولة (`timeoutSeconds`، الافتراضي 60 ثانية) لتجنّب حجب طابور الردود.
