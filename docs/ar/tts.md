---
summary: "تحويل النص إلى كلام (TTS) للردود الصادرة"
read_when:
  - تمكين تحويل النص إلى كلام للردود
  - تهيئة موفّري TTS أو الحدود
  - استخدام أوامر /tts
title: "النص إلى الكلام"
---

# تحويل النص إلى كلام (TTS)

يمكن لـ OpenClaw تحويل الردود الصادرة إلى صوت باستخدام ElevenLabs أو OpenAI أو Edge TTS.
ويعمل ذلك في أي مكان يستطيع فيه OpenClaw إرسال صوت؛ إذ يحصل Telegram على فقاعة ملاحظة صوتية دائرية.

## الخدمات المدعومة

- **ElevenLabs** (موفّر أساسي أو احتياطي)
- **OpenAI** (موفّر أساسي أو احتياطي؛ ويُستخدم أيضًا للملخّصات)
- **Edge TTS** (موفّر أساسي أو احتياطي؛ يستخدم `node-edge-tts`، وهو الافتراضي عند عدم وجود مفاتيح API)

### ملاحظات Edge TTS

يستخدم Edge TTS خدمة تحويل النص إلى كلام العصبية عبر الإنترنت الخاصة بـ Microsoft Edge من خلال مكتبة
`node-edge-tts`. وهي خدمة مستضافة (غير محلية)، تستخدم نقاط نهاية Microsoft، ولا تتطلب مفتاح API. تكشف `node-edge-tts` عن خيارات تهيئة الكلام وتنسيقات الإخراج، ولكن ليست كل الخيارات مدعومة من خدمة Edge. citeturn2search0

نظرًا لأن Edge TTS خدمة ويب عامة بدون اتفاقية مستوى خدمة (SLA) أو حصة منشورة، فتعامل معها كأفضل جهد. إذا كنت بحاجة إلى حدود مضمونة ودعم، فاستخدم OpenAI أو ElevenLabs.
توثّق واجهة Microsoft Speech REST API
حدًا أقصى للصوت مدته 10 دقائق لكل طلب؛ ولا تنشر Edge TTS حدودًا، لذا افترض حدودًا مماثلة أو أقل. citeturn0search3

## المفاتيح الاختيارية

إذا كنت تريد OpenAI أو ElevenLabs:

- `ELEVENLABS_API_KEY` (أو `XI_API_KEY`)
- `OPENAI_API_KEY`

لا يتطلب Edge TTS مفتاح API. إذا لم يتم العثور على أي مفاتيح API، يستخدم OpenClaw افتراضيًا Edge TTS
(ما لم يتم تعطيله عبر `messages.tts.edge.enabled=false`).

إذا تم تهيئة عدة موفّرين، فسيتم استخدام الموفّر المحدد أولًا وتُستخدم البقية كخيارات احتياطية.
يستخدم التلخيص التلقائي المهيّأ `summaryModel` (أو `agents.defaults.model.primary`)،
لذا يجب توثيق ذلك الموفّر أيضًا إذا قمت بتمكين الملخّصات.

## روابط الخدمات

- [دليل OpenAI لتحويل النص إلى كلام](https://platform.openai.com/docs/guides/text-to-speech)
- [مرجع واجهة OpenAI Audio API](https://platform.openai.com/docs/api-reference/audio)
- [تحويل النص إلى كلام من ElevenLabs](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [مصادقة ElevenLabs](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [تنسيقات إخراج Microsoft Speech](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## هل هو مُمكّن افتراضيًا؟

لا. إن Auto‑TTS **متوقف** افتراضيًا. قم بتمكينه في التهيئة باستخدام
`messages.tts.auto` أو لكل جلسة باستخدام `/tts always` (الاسم المستعار: `/tts on`).

يكون Edge TTS **مُمكّنًا** افتراضيًا بمجرد تشغيل TTS، ويُستخدم تلقائيًا
عند عدم توفر مفاتيح API لـ OpenAI أو ElevenLabs.

## التهيئة

توجد تهيئة TTS ضمن `messages.tts` في `openclaw.json`.
المخطط الكامل موجود في [تهيئة Gateway](/gateway/configuration).

### الحد الأدنى من التهيئة (تمكين + موفّر)

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "elevenlabs",
    },
  },
}
```

### OpenAI أساسي مع ElevenLabs كاحتياطي

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "openai",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: {
        enabled: true,
      },
      openai: {
        apiKey: "openai_api_key",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
      elevenlabs: {
        apiKey: "elevenlabs_api_key",
        baseUrl: "https://api.elevenlabs.io",
        voiceId: "voice_id",
        modelId: "eleven_multilingual_v2",
        seed: 42,
        applyTextNormalization: "auto",
        languageCode: "en",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0.0,
          useSpeakerBoost: true,
          speed: 1.0,
        },
      },
    },
  },
}
```

### Edge TTS أساسي (بدون مفتاح API)

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "edge",
      edge: {
        enabled: true,
        voice: "en-US-MichelleNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        rate: "+10%",
        pitch: "-5%",
      },
    },
  },
}
```

### تعطيل Edge TTS

```json5
{
  messages: {
    tts: {
      edge: {
        enabled: false,
      },
    },
  },
}
```

### حدود مخصّصة + مسار التفضيلات

```json5
{
  messages: {
    tts: {
      auto: "always",
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.openclaw/settings/tts.json",
    },
  },
}
```

### الرد بالصوت فقط بعد ملاحظة صوتية واردة

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### تعطيل التلخيص التلقائي للردود الطويلة

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

ثم شغّل:

```
/tts summary off
```

### ملاحظات حول الحقول

- `auto`: وضع Auto‑TTS (`off`، `always`، `inbound`، `tagged`).
  - `inbound` يرسل الصوت فقط بعد ملاحظة صوتية واردة.
  - `tagged` يرسل الصوت فقط عندما يتضمن الرد وسوم `[[tts]]`.
- `enabled`: مفتاح تبديل قديم (يقوم doctor بترحيله إلى `auto`).
- `mode`: `"final"` (الافتراضي) أو `"all"` (يتضمن ردود الأدوات/الكتل).
- `provider`: `"elevenlabs"` أو `"openai"` أو `"edge"` (الاحتياطي تلقائي).
- إذا كان `provider` **غير مضبوط**، يفضّل OpenClaw `openai` (إن وُجد المفتاح)، ثم `elevenlabs` (إن وُجد المفتاح)،
  وإلا `edge`.
- `summaryModel`: نموذج رخيص اختياري للتلخيص التلقائي؛ الافتراضي هو `agents.defaults.model.primary`.
  - يقبل `provider/model` أو اسمًا مستعارًا لنموذج مُهيّأ.
- `modelOverrides`: السماح للنموذج بإصدار توجيهات TTS (مُفعل افتراضيًا).
- `maxTextLength`: حد صارم لإدخال TTS (عدد الأحرف). يفشل `/tts audio` إذا تم تجاوزه.
- `timeoutMs`: مهلة الطلب (مللي ثانية).
- `prefsPath`: تجاوز مسار JSON المحلي للتفضيلات (الموفّر/الحد/الملخّص).
- `apiKey` تعود قيمها إلى متغيرات البيئة (`ELEVENLABS_API_KEY`/`XI_API_KEY`، `OPENAI_API_KEY`).
- `elevenlabs.baseUrl`: تجاوز عنوان URL الأساسي لواجهة ElevenLabs.
- `elevenlabs.voiceSettings`:
  - `stability`، `similarityBoost`، `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = طبيعي)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: رمز ISO 639-1 من حرفين (مثل `en`، `de`)
- `elevenlabs.seed`: عدد صحيح `0..4294967295` (حتمية بأفضل جهد)
- `edge.enabled`: السماح باستخدام Edge TTS (الافتراضي `true`؛ بدون مفتاح API).
- `edge.voice`: اسم الصوت العصبي لـ Edge (مثل `en-US-MichelleNeural`).
- `edge.lang`: رمز اللغة (مثل `en-US`).
- `edge.outputFormat`: تنسيق إخراج Edge (مثل `audio-24khz-48kbitrate-mono-mp3`).
  - راجع تنسيقات إخراج Microsoft Speech للقيم الصالحة؛ ليست كل التنسيقات مدعومة من Edge.
- `edge.rate` / `edge.pitch` / `edge.volume`: سلاسل نسب مئوية (مثل `+10%`، `-5%`).
- `edge.saveSubtitles`: كتابة ترجمات JSON بجانب ملف الصوت.
- `edge.proxy`: عنوان URL للوكيل لطلبات Edge TTS.
- `edge.timeoutMs`: تجاوز مهلة الطلب (مللي ثانية).

## التجاوزات المدفوعة بالنموذج (مُفعّلة افتراضيًا)

افتراضيًا، **يمكن** للنموذج إصدار توجيهات TTS لرد واحد.
عندما تكون `messages.tts.auto` هي `tagged`، تكون هذه التوجيهات مطلوبة لتشغيل الصوت.

عند التمكين، يمكن للنموذج إصدار توجيهات `[[tts:...]]` لتجاوز الصوت
لرد واحد، بالإضافة إلى كتلة `[[tts:text]]...[[/tts:text]]` اختيارية
لتوفير وسوم تعبيرية (ضحك، إشارات غناء، إلخ) يجب أن تظهر في
الصوت فقط.

مثال على حمولة الرد:

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

مفاتيح التوجيه المتاحة (عند التمكين):

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice` (صوت OpenAI) أو `voiceId` (ElevenLabs)
- `model` (نموذج TTS من OpenAI أو معرّف نموذج ElevenLabs)
- `stability`، `similarityBoost`، `style`، `speed`، `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

تعطيل جميع تجاوزات النموذج:

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: false,
      },
    },
  },
}
```

قائمة سماح اختيارية (تعطيل تجاوزات محددة مع إبقاء الوسوم مُمكّنة):

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: true,
        allowProvider: false,
        allowSeed: false,
      },
    },
  },
}
```

## تفضيلات لكل مستخدم

تكتب أوامر الشرطة المائلة التجاوزات المحلية إلى `prefsPath` (الافتراضي:
`~/.openclaw/settings/tts.json`، ويمكن التجاوز باستخدام `OPENCLAW_TTS_PREFS` أو
`messages.tts.prefsPath`).

الحقول المخزّنة:

- `enabled`
- `provider`
- `maxLength` (عتبة التلخيص؛ الافتراضي 1500 حرف)
- `summarize` (الافتراضي `true`)

تتجاوز هذه القيم `messages.tts.*` لذلك المضيف.

## تنسيقات الإخراج (ثابتة)

- **Telegram**: ملاحظة صوتية Opus (`opus_48000_64` من ElevenLabs، `opus` من OpenAI).
  - 48kHz / 64kbps توازن جيد للملاحظات الصوتية ومطلوب للفقاعة الدائرية.
- **القنوات الأخرى**: MP3 (`mp3_44100_128` من ElevenLabs، `mp3` من OpenAI).
  - 44.1kHz / 128kbps هو التوازن الافتراضي لوضوح الكلام.
- **Edge TTS**: يستخدم `edge.outputFormat` (الافتراضي `audio-24khz-48kbitrate-mono-mp3`).
  - يقبل `node-edge-tts` قيمة `outputFormat`، ولكن ليست كل التنسيقات متاحة
    من خدمة Edge. citeturn2search0
  - تتبع قيم تنسيق الإخراج تنسيقات Microsoft Speech (بما في ذلك Ogg/WebM Opus). citeturn1search0
  - تقبل `sendVoice` في Telegram تنسيقات OGG/MP3/M4A؛ استخدم OpenAI/ElevenLabs إذا كنت بحاجة إلى
    ملاحظات صوتية Opus مضمونة. citeturn1search1
  - إذا فشل تنسيق إخراج Edge المهيّأ، يعيد OpenClaw المحاولة باستخدام MP3.

تنسيقات OpenAI/ElevenLabs ثابتة؛ ويتوقع Telegram تنسيق Opus لتجربة الملاحظة الصوتية.

## سلوك Auto‑TTS

عند التمكين، يقوم OpenClaw بما يلي:

- يتجاوز TTS إذا كان الرد يحتوي بالفعل على وسائط أو توجيه `MEDIA:`.
- يتجاوز الردود القصيرة جدًا (< 10 أحرف).
- يختصر الردود الطويلة عند التمكين باستخدام `agents.defaults.model.primary` (أو `summaryModel`).
- يرفق الصوت المُنشأ بالرد.

إذا تجاوز الرد `maxLength` وكان التلخيص متوقفًا (أو لا يوجد مفتاح API لنموذج
التلخيص)،
يتم تجاوز الصوت وإرسال الرد النصي العادي.

## مخطط التدفق

```
Reply -> TTS enabled?
  no  -> send text
  yes -> has media / MEDIA: / short?
          yes -> send text
          no  -> length > limit?
                   no  -> TTS -> attach audio
                   yes -> summary enabled?
                            no  -> send text
                            yes -> summarize (summaryModel or agents.defaults.model.primary)
                                      -> TTS -> attach audio
```

## استخدام أمر Slash

يوجد أمر واحد: `/tts`.
راجع [أوامر الشرطة المائلة](/tools/slash-commands) لتفاصيل التمكين.

ملاحظة Discord: إن `/tts` أمر مدمج في Discord، لذا يسجّل OpenClaw
`/voice` كأمر أصلي هناك. ولا يزال النص `/tts ...` يعمل.

```
/tts off
/tts always
/tts inbound
/tts tagged
/tts status
/tts provider openai
/tts limit 2000
/tts summary off
/tts audio Hello from OpenClaw
```

ملاحظات:

- تتطلب الأوامر مُرسِلًا مخوّلًا (ولا تزال قواعد قائمة السماح/المالك سارية).
- يجب تمكين `commands.text` أو تسجيل الأوامر الأصلية.
- `off|always|inbound|tagged` هي مفاتيح تبديل لكل جلسة (`/tts on` اسم مستعار لـ `/tts always`).
- يتم تخزين `limit` و `summary` في التفضيلات المحلية، وليس في التهيئة الرئيسية.
- يُنشئ `/tts audio` ردًا صوتيًا لمرة واحدة (ولا يفعّل TTS).

## أداة الوكيل

تحوّل أداة `tts` النص إلى كلام وتُرجع مسار `MEDIA:`. وعندما تكون
النتيجة متوافقة مع Telegram، تتضمن الأداة `[[audio_as_voice]]` بحيث
يرسل Telegram فقاعة صوتية.

## Gateway RPC

طرق Gateway:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
