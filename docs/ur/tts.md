---
summary: "بیرونی جوابات کے لیے متن سے آواز (TTS)"
read_when:
  - جوابات کے لیے متن سے آواز کو فعال کرنا
  - TTS فراہم کنندگان یا حدود کی کنفیگریشن
  - /tts کمانڈز کا استعمال
title: "متن سے آواز"
---

# متن سے آواز (TTS)

OpenClaw آؤٹ باؤنڈ جوابات کو ElevenLabs، OpenAI، یا Edge TTS کے ذریعے آڈیو میں تبدیل کر سکتا ہے۔
یہ ہر اس جگہ کام کرتا ہے جہاں OpenClaw آڈیو بھیج سکتا ہے؛ Telegram میں ایک گول وائس-نوٹ ببل ملتا ہے۔

## معاون خدمات

- **ElevenLabs** (بنیادی یا فال بیک فراہم کنندہ)
- **OpenAI** (بنیادی یا فال بیک فراہم کنندہ؛ خلاصوں کے لیے بھی استعمال ہوتا ہے)
- **Edge TTS** (بنیادی یا فال بیک فراہم کنندہ؛ `node-edge-tts` استعمال کرتا ہے، جب کوئی API کلید نہ ہو تو بطورِ طے شدہ)

### Edge TTS نوٹس

Edge TTS، `node-edge-tts` لائبریری کے ذریعے Microsoft Edge کی آن لائن نیورل TTS سروس استعمال کرتا ہے۔ یہ ایک ہوسٹڈ سروس ہے (لوکل نہیں)، Microsoft کے endpoints استعمال کرتی ہے، اور API key کی ضرورت نہیں ہوتی۔ `node-edge-tts` اسپیچ کنفیگریشن آپشنز اور آؤٹ پٹ فارمیٹس فراہم کرتا ہے، لیکن تمام آپشنز Edge سروس کے ذریعے سپورٹڈ نہیں ہوتے۔ citeturn2search0

چونکہ Edge TTS ایک عوامی ویب سروس ہے جس کی کوئی شائع شدہ SLA یا quota نہیں، اس لیے اسے best-effort سمجھیں۔ اگر آپ کو ضمانت شدہ حدود اور سپورٹ درکار ہو تو OpenAI یا ElevenLabs استعمال کریں۔
Microsoft کی Speech REST API فی درخواست 10‑منٹ آڈیو کی حد دستاویز کرتی ہے؛ Edge TTS حدود شائع نہیں کرتا، اس لیے ملتی جلتی یا اس سے کم حدود فرض کریں۔ citeturn0search3

## اختیاری کلیدیں

اگر آپ OpenAI یا ElevenLabs چاہتے ہیں:

- `ELEVENLABS_API_KEY` (یا `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS کو **API key** کی ضرورت نہیں ہوتی۔ اگر کوئی API keys نہ ملیں تو OpenClaw ڈیفالٹ طور پر Edge TTS استعمال کرتا ہے
(جب تک `messages.tts.edge.enabled=false` کے ذریعے غیر فعال نہ کیا گیا ہو)۔

اگر متعدد فراہم کنندگان کنفیگر کیے گئے ہوں تو منتخب کردہ فراہم کنندہ پہلے استعمال ہوتا ہے اور باقی بیک اپ کے طور پر کام کرتے ہیں۔
آٹو خلاصہ کنفیگر کیے گئے `summaryModel` (یا `agents.defaults.model.primary`) کو استعمال کرتا ہے،
اس لیے اگر آپ خلاصے فعال کریں تو اس فراہم کنندہ کی توثیق بھی ضروری ہے۔

## سروس لنکس

- [OpenAI Text-to-Speech guide](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API reference](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs Authentication](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft Speech output formats](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## کیا یہ بطورِ طے شدہ فعال ہے؟

نہیں. آٹو‑TTS بطورِ ڈیفالٹ **بند** ہوتا ہے۔ اسے کنفیگ میں
`messages.tts.auto` کے ذریعے یا فی سیشن `/tts always` (عرف: `/tts on`) سے فعال کریں۔

جب TTS آن ہو تو Edge TTS **بطورِ طے شدہ فعال** ہوتا ہے، اور
جب OpenAI یا ElevenLabs کی API کلیدیں دستیاب نہ ہوں تو خودکار طور پر استعمال ہوتا ہے۔

## کنفیگ

TTS config lives under `messages.tts` in `openclaw.json`.
مکمل اسکیما [Gateway configuration](/gateway/configuration) میں موجود ہے۔

### کم از کم کنفیگ (فعال + فراہم کنندہ)

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

### OpenAI بطورِ بنیادی، ElevenLabs فال بیک کے طور پر

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

### Edge TTS بطورِ بنیادی (کوئی API کلید نہیں)

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

### Edge TTS غیر فعال کریں

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

### حسبِ ضرورت حدود + prefs راستہ

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

### صرف اس وقت آڈیو کے ساتھ جواب دیں جب اندرونی وائس نوٹ آئے

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### طویل جوابات کے لیے خودکار خلاصہ غیر فعال کریں

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

پھر چلائیں:

```
/tts summary off
```

### فیلڈز پر نوٹس

- `auto`: خودکار‑TTS موڈ (`off`, `always`, `inbound`, `tagged`)۔
  - `inbound` صرف اندرونی وائس نوٹ کے بعد آڈیو بھیجتا ہے۔
  - `tagged` صرف اس وقت آڈیو بھیجتا ہے جب جواب میں `[[tts]]` ٹیگز شامل ہوں۔
- `enabled`: لیگیسی ٹوگل (doctor اسے `auto` میں منتقل کرتا ہے)۔
- `mode`: `"final"` (بطورِ طے شدہ) یا `"all"` (اوزار/بلاک جوابات شامل)۔
- `provider`: `"elevenlabs"`, `"openai"`, یا `"edge"` (فال بیک خودکار ہے)۔
- اگر `provider` **غیر متعین** ہو تو OpenClaw ترجیح دیتا ہے `openai` (اگر کلید ہو)، پھر `elevenlabs` (اگر کلید ہو)،
  بصورتِ دیگر `edge`۔
- `summaryModel`: خودکار خلاصے کے لیے اختیاری کم خرچ ماڈل؛ بطورِ طے شدہ `agents.defaults.model.primary`۔
  - `provider/model` یا کنفیگر شدہ ماڈل عرف قبول کرتا ہے۔
- `modelOverrides`: ماڈل کو TTS ہدایات اخراج کرنے کی اجازت (بطورِ طے شدہ آن)۔
- `maxTextLength`: TTS ان پٹ کے لیے سخت حد (حروف کی تعداد)۔ حد سے تجاوز ہونے پر `/tts audio` ناکام ہو جاتا ہے۔
- `timeoutMs`: درخواست کا ٹائم آؤٹ (ملی سیکنڈ)۔
- `prefsPath`: لوکل prefs JSON راستہ اووررائیڈ کریں (فراہم کنندہ/حد/خلاصہ)۔
- `apiKey` کی قدریں env vars (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`) پر فال بیک کرتی ہیں۔
- `elevenlabs.baseUrl`: ElevenLabs API بیس URL اووررائیڈ۔
- `elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = معمول)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: دو حرفی ISO 639-1 (مثلاً `en`, `de`)
- `elevenlabs.seed`: عددی `0..4294967295` (best‑effort تعین پذیری)
- `edge.enabled`: Edge TTS استعمال کی اجازت (بطورِ طے شدہ `true`; کوئی API کلید نہیں)۔
- `edge.voice`: Edge نیورل آواز کا نام (مثلاً `en-US-MichelleNeural`)۔
- `edge.lang`: زبان کا کوڈ (مثلاً `en-US`)۔
- `edge.outputFormat`: Edge آؤٹ پٹ فارمیٹ (مثلاً `audio-24khz-48kbitrate-mono-mp3`)۔
  - درست قدروں کے لیے Microsoft Speech output formats دیکھیں؛ Edge تمام فارمیٹس کی حمایت نہیں کرتا۔
- `edge.rate` / `edge.pitch` / `edge.volume`: فیصدی اسٹرنگز (مثلاً `+10%`, `-5%`)۔
- `edge.saveSubtitles`: آڈیو فائل کے ساتھ JSON سب ٹائٹلز لکھیں۔
- `edge.proxy`: Edge TTS درخواستوں کے لیے پراکسی URL۔
- `edge.timeoutMs`: درخواست ٹائم آؤٹ اووررائیڈ (ملی سیکنڈ)۔

## ماڈل‑ڈرائیون اووررائیڈز (بطورِ طے شدہ آن)

بطورِ ڈیفالٹ، ماڈل ایک ہی جواب کے لیے TTS ہدایات جاری **کر سکتا ہے**۔
جب `messages.tts.auto` کی قدر `tagged` ہو تو آڈیو کو متحرک کرنے کے لیے یہ ہدایات لازمی ہیں۔

فعال ہونے پر، ماڈل ایک جواب کے لیے آواز اووررائیڈ کرنے کی خاطر `[[tts:...]]` ہدایات اخراج کر سکتا ہے،
اور ساتھ ایک اختیاری `[[tts:text]]...[[/tts:text]]` بلاک بھی دے سکتا ہے تاکہ
اظہاری ٹیگز (ہنسی، گانے کے اشارے وغیرہ) فراہم کیے جائیں جو صرف آڈیو میں ظاہر ہوں۔

مثالی جواب پے لوڈ:

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

دستیاب ہدایت کلیدیں (جب فعال ہوں):

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice` (OpenAI آواز) یا `voiceId` (ElevenLabs)
- `model` (OpenAI TTS ماڈل یا ElevenLabs ماڈل id)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

تمام ماڈل اووررائیڈز غیر فعال کریں:

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

اختیاری اجازت فہرست (ٹیگز کو فعال رکھتے ہوئے مخصوص اووررائیڈز غیر فعال کریں):

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

## فی‑صارف ترجیحات

سلیش کمانڈز لوکل اووررائیڈز `prefsPath` میں لکھتی ہیں (بطورِ طے شدہ:
`~/.openclaw/settings/tts.json`، `OPENCLAW_TTS_PREFS` یا
`messages.tts.prefsPath` سے اووررائیڈ کریں)۔

محفوظ شدہ فیلڈز:

- `enabled`
- `provider`
- `maxLength` (خلاصہ حد؛ بطورِ طے شدہ 1500 حروف)
- `summarize` (بطورِ طے شدہ `true`)

یہ اس ہوسٹ کے لیے `messages.tts.*` کو اووررائیڈ کرتی ہیں۔

## آؤٹ پٹ فارمیٹس (مقرر)

- **Telegram**: Opus وائس نوٹ (`opus_48000_64` ElevenLabs سے، `opus` OpenAI سے)۔
  - 48kHz / 64kbps وائس نوٹ کے لیے اچھا توازن ہے اور گول ببل کے لیے ضروری ہے۔
- **دیگر چینلز**: MP3 (`mp3_44100_128` ElevenLabs سے، `mp3` OpenAI سے)۔
  - 44.1kHz / 128kbps تقریر کی وضاحت کے لیے طے شدہ توازن ہے۔
- **Edge TTS**: `edge.outputFormat` استعمال کرتا ہے (بطورِ طے شدہ `audio-24khz-48kbitrate-mono-mp3`)۔
  - `node-edge-tts` ایک `outputFormat` قبول کرتا ہے، لیکن Edge سروس سے تمام فارمیٹس دستیاب نہیں ہوتے۔ citeturn2search0
  - آؤٹ پٹ فارمیٹ کی قدریں Microsoft Speech کے آؤٹ پٹ فارمیٹس کی پیروی کرتی ہیں (بشمول Ogg/WebM Opus)۔ citeturn1search0
  - Telegram کا `sendVoice` OGG/MP3/M4A قبول کرتا ہے؛ اگر آپ کو یقینی Opus وائس نوٹس درکار ہوں تو OpenAI/ElevenLabs استعمال کریں۔ citeturn1search1
  - اگر کنفیگر شدہ Edge آؤٹ پٹ فارمیٹ ناکام ہو جائے تو OpenClaw MP3 کے ساتھ دوبارہ کوشش کرتا ہے۔

OpenAI/ElevenLabs کے فارمیٹس مقرر ہیں؛ Telegram وائس نوٹ UX کے لیے Opus متوقع رکھتا ہے۔

## خودکار‑TTS رویہ

فعال ہونے پر، OpenClaw:

- اگر جواب میں پہلے سے میڈیا یا `MEDIA:` ہدایت موجود ہو تو TTS چھوڑ دیتا ہے۔
- بہت مختصر جوابات (< 10 حروف) چھوڑ دیتا ہے۔
- طویل جوابات کو فعال ہونے پر `agents.defaults.model.primary` (یا `summaryModel`) کے ذریعے خلاصہ کرتا ہے۔
- تیار کردہ آڈیو کو جواب کے ساتھ منسلک کرتا ہے۔

اگر جواب `maxLength` سے تجاوز کرے اور خلاصہ بند ہو (یا
خلاصہ ماڈل کے لیے کوئی API کلید نہ ہو)، تو آڈیو چھوڑ دیا جاتا ہے اور
معمول کا متنی جواب بھیجا جاتا ہے۔

## فلو ڈایاگرام

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

## سلیش کمانڈ کا استعمال

صرف ایک کمانڈ ہے: `/tts`۔
فعال کرنے کی تفصیلات کے لیے [Slash commands](/tools/slash-commands) دیکھیں۔

Discord نوٹ: `/tts` ایک بلٹ اِن Discord کمانڈ ہے، اس لیے OpenClaw وہاں مقامی کمانڈ کے طور پر
`/voice` رجسٹر کرتا ہے۔ متن `/tts ...` پھر بھی کام کرتا ہے۔

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

نوٹس:

- کمانڈز کے لیے مجاز ارسال کنندہ درکار ہے (اجازت فہرست/مالک کے قواعد لاگو رہتے ہیں)۔
- `commands.text` یا نیٹو کمانڈ رجسٹریشن فعال ہونی چاہیے۔
- `off|always|inbound|tagged` فی‑سیشن ٹوگلز ہیں (`/tts on`، `/tts always` کا عرف ہے)۔
- `limit` اور `summary` لوکل prefs میں محفوظ ہوتے ہیں، مرکزی کنفیگ میں نہیں۔
- `/tts audio` ایک بار کی آڈیو جواب تیار کرتا ہے (TTS آن نہیں کرتا)۔

## ایجنٹ ٹول

`tts` ٹول متن کو آواز میں تبدیل کرتا ہے اور ایک `MEDIA:` پاتھ واپس کرتا ہے۔ جب نتیجہ Telegram کے ساتھ مطابقت رکھتا ہو تو ٹول `[[audio_as_voice]]` شامل کرتا ہے تاکہ
Telegram ایک وائس ببل بھیجے۔

## Gateway RPC

Gateway طریقے:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
