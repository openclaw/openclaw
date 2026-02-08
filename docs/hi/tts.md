---
summary: "आउटबाउंड उत्तरों के लिए टेक्स्ट-टू-स्पीच (TTS)"
read_when:
  - उत्तरों के लिए टेक्स्ट-टू-स्पीच सक्षम करना
  - TTS प्रदाताओं या सीमाओं का विन्यास
  - /tts कमांड का उपयोग
title: "टेक्स्ट-टू-स्पीच"
x-i18n:
  source_path: tts.md
  source_hash: 070ff0cc8592f64c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:14Z
---

# टेक्स्ट-टू-स्पीच (TTS)

OpenClaw, ElevenLabs, OpenAI, या Edge TTS का उपयोग करके आउटबाउंड उत्तरों को ऑडियो में परिवर्तित कर सकता है।
यह वहाँ भी काम करता है जहाँ OpenClaw ऑडियो भेज सकता है; Telegram में गोल वॉइस-नोट बबल मिलता है।

## समर्थित सेवाएँ

- **ElevenLabs** (प्राथमिक या फ़ॉलबैक प्रदाता)
- **OpenAI** (प्राथमिक या फ़ॉलबैक प्रदाता; सारांश के लिए भी उपयोग होता है)
- **Edge TTS** (प्राथमिक या फ़ॉलबैक प्रदाता; `node-edge-tts` का उपयोग करता है, API कुंजी न होने पर डिफ़ॉल्ट)

### Edge TTS नोट्स

Edge TTS, `node-edge-tts` लाइब्रेरी के माध्यम से Microsoft Edge की ऑनलाइन न्यूरल TTS सेवा का उपयोग करता है।
यह एक होस्टेड सेवा है (स्थानीय नहीं), Microsoft के एंडपॉइंट्स का उपयोग करती है, और
इसके लिए API कुंजी की आवश्यकता नहीं होती। `node-edge-tts` स्पीच विन्यास विकल्प और
आउटपुट फ़ॉर्मैट्स को एक्सपोज़ करता है, लेकिन Edge सेवा सभी विकल्पों का समर्थन नहीं करती। citeturn2search0

क्योंकि Edge TTS एक सार्वजनिक वेब सेवा है जिसमें प्रकाशित SLA या कोटा नहीं है, इसे
best-effort के रूप में मानें। यदि आपको गारंटीकृत सीमाएँ और समर्थन चाहिए, तो OpenAI या ElevenLabs का उपयोग करें।
Microsoft की Speech REST API प्रति अनुरोध 10‑मिनट की ऑडियो सीमा का दस्तावेज़ देती है; Edge TTS
सीमाएँ प्रकाशित नहीं करता, इसलिए समान या उससे कम सीमाएँ मानें। citeturn0search3

## वैकल्पिक कुंजियाँ

यदि आप OpenAI या ElevenLabs चाहते हैं:

- `ELEVENLABS_API_KEY` (या `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS के लिए API कुंजी की **आवश्यकता नहीं** है। यदि कोई API कुंजी नहीं मिलती,
तो OpenClaw डिफ़ॉल्ट रूप से Edge TTS का उपयोग करता है (जब तक `messages.tts.edge.enabled=false` के माध्यम से अक्षम न किया गया हो)।

यदि कई प्रदाता विन्यस्त हैं, तो चयनित प्रदाता पहले उपयोग होता है और अन्य फ़ॉलबैक विकल्प होते हैं।
ऑटो‑सारांश विन्यस्त `summaryModel` (या `agents.defaults.model.primary`) का उपयोग करता है,
इसलिए यदि आप सारांश सक्षम करते हैं तो उस प्रदाता का प्रमाणीकरण भी आवश्यक है।

## सेवा लिंक

- [OpenAI Text-to-Speech guide](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API reference](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs Authentication](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft Speech output formats](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## क्या यह डिफ़ॉल्ट रूप से सक्षम है?

नहीं। Auto‑TTS डिफ़ॉल्ट रूप से **बंद** है। इसे config में
`messages.tts.auto` के साथ या प्रति सत्र `/tts always` (उपनाम: `/tts on`) के साथ सक्षम करें।

एक बार TTS चालू होने पर Edge TTS डिफ़ॉल्ट रूप से **सक्षम** होता है, और
जब कोई OpenAI या ElevenLabs API कुंजी उपलब्ध न हो तो स्वचालित रूप से उपयोग होता है।

## Config

TTS का config `openclaw.json` में `messages.tts` के अंतर्गत रहता है।
पूर्ण स्कीमा [Gateway configuration](/gateway/configuration) में है।

### न्यूनतम config (सक्षम + प्रदाता)

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

### OpenAI प्राथमिक, ElevenLabs फ़ॉलबैक

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

### Edge TTS प्राथमिक (कोई API कुंजी नहीं)

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

### Edge TTS अक्षम करें

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

### कस्टम सीमाएँ + prefs पथ

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

### केवल इनबाउंड वॉइस नोट के बाद ऑडियो के साथ उत्तर दें

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### लंबे उत्तरों के लिए ऑटो‑सारांश अक्षम करें

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

फिर चलाएँ:

```
/tts summary off
```

### फ़ील्ड्स पर नोट्स

- `auto`: auto‑TTS मोड (`off`, `always`, `inbound`, `tagged`)।
  - `inbound` केवल इनबाउंड वॉइस नोट के बाद ऑडियो भेजता है।
  - `tagged` केवल तब ऑडियो भेजता है जब उत्तर में `[[tts]]` टैग शामिल हों।
- `enabled`: legacy टॉगल (doctor इसे `auto` में माइग्रेट करता है)।
- `mode`: `"final"` (डिफ़ॉल्ट) या `"all"` (टूल/ब्लॉक उत्तर शामिल)।
- `provider`: `"elevenlabs"`, `"openai"`, या `"edge"` (फ़ॉलबैक स्वचालित है)।
- यदि `provider` **सेट नहीं** है, तो OpenClaw `openai` (यदि कुंजी), फिर `elevenlabs` (यदि कुंजी),
  अन्यथा `edge` को प्राथमिकता देता है।
- `summaryModel`: ऑटो‑सारांश के लिए वैकल्पिक सस्ता मॉडल; डिफ़ॉल्ट `agents.defaults.model.primary`।
  - `provider/model` या किसी विन्यस्त मॉडल उपनाम को स्वीकार करता है।
- `modelOverrides`: मॉडल को TTS निर्देश उत्पन्न करने की अनुमति दें (डिफ़ॉल्ट रूप से चालू)।
- `maxTextLength`: TTS इनपुट के लिए हार्ड कैप (अक्षर)। सीमा पार होने पर `/tts audio` विफल होता है।
- `timeoutMs`: अनुरोध टाइमआउट (ms)।
- `prefsPath`: स्थानीय prefs JSON पथ ओवरराइड करें (प्रदाता/सीमा/सारांश)।
- `apiKey` मान env vars (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`) पर फ़ॉलबैक करते हैं।
- `elevenlabs.baseUrl`: ElevenLabs API बेस URL ओवरराइड करें।
- `elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = सामान्य)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: 2-अक्षरी ISO 639-1 (उदा. `en`, `de`)
- `elevenlabs.seed`: पूर्णांक `0..4294967295` (best-effort निर्धारकता)
- `edge.enabled`: Edge TTS उपयोग की अनुमति (डिफ़ॉल्ट `true`; कोई API कुंजी नहीं)।
- `edge.voice`: Edge न्यूरल वॉइस नाम (उदा. `en-US-MichelleNeural`)।
- `edge.lang`: भाषा कोड (उदा. `en-US`)।
- `edge.outputFormat`: Edge आउटपुट फ़ॉर्मैट (उदा. `audio-24khz-48kbitrate-mono-mp3`)।
  - मान्य मानों के लिए Microsoft Speech output formats देखें; Edge सभी फ़ॉर्मैट्स का समर्थन नहीं करता।
- `edge.rate` / `edge.pitch` / `edge.volume`: प्रतिशत स्ट्रिंग्स (उदा. `+10%`, `-5%`)।
- `edge.saveSubtitles`: ऑडियो फ़ाइल के साथ JSON उपशीर्षक लिखें।
- `edge.proxy`: Edge TTS अनुरोधों के लिए प्रॉक्सी URL।
- `edge.timeoutMs`: अनुरोध टाइमआउट ओवरराइड (ms)।

## मॉडल‑ड्रिवन ओवरराइड्स (डिफ़ॉल्ट चालू)

डिफ़ॉल्ट रूप से, मॉडल एकल उत्तर के लिए TTS निर्देश **उत्पन्न कर सकता है**।
जब `messages.tts.auto` `tagged` हो, तब ऑडियो ट्रिगर करने के लिए ये निर्देश आवश्यक होते हैं।

सक्षम होने पर, मॉडल एकल उत्तर के लिए वॉइस ओवरराइड करने हेतु `[[tts:...]]` निर्देश
और वैकल्पिक `[[tts:text]]...[[/tts:text]]` ब्लॉक उत्पन्न कर सकता है, ताकि
अभिव्यंजक टैग (हँसी, गायन संकेत आदि) दिए जा सकें जो केवल
ऑडियो में दिखाई देने चाहिए।

उदाहरण उत्तर payload:

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

उपलब्ध निर्देश कुंजियाँ (सक्षम होने पर):

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice` (OpenAI वॉइस) या `voiceId` (ElevenLabs)
- `model` (OpenAI TTS मॉडल या ElevenLabs मॉडल id)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

सभी मॉडल ओवरराइड्स अक्षम करें:

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

वैकल्पिक allowlist (टैग सक्षम रखते हुए विशिष्ट ओवरराइड्स अक्षम करें):

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

## प्रति‑उपयोगकर्ता प्राथमिकताएँ

Slash कमांड स्थानीय ओवरराइड्स को `prefsPath` में लिखते हैं (डिफ़ॉल्ट:
`~/.openclaw/settings/tts.json`; `OPENCLAW_TTS_PREFS` या
`messages.tts.prefsPath` से ओवरराइड करें)।

संग्रहीत फ़ील्ड्स:

- `enabled`
- `provider`
- `maxLength` (सारांश सीमा; डिफ़ॉल्ट 1500 अक्षर)
- `summarize` (डिफ़ॉल्ट `true`)

ये उस होस्ट के लिए `messages.tts.*` को ओवरराइड करते हैं।

## आउटपुट फ़ॉर्मैट्स (स्थिर)

- **Telegram**: Opus वॉइस नोट (ElevenLabs से `opus_48000_64`, OpenAI से `opus`)।
  - 48kHz / 64kbps वॉइस‑नोट के लिए अच्छा संतुलन है और गोल बबल के लिए आवश्यक है।
- **अन्य चैनल**: MP3 (ElevenLabs से `mp3_44100_128`, OpenAI से `mp3`)।
  - 44.1kHz / 128kbps भाषण स्पष्टता के लिए डिफ़ॉल्ट संतुलन है।
- **Edge TTS**: `edge.outputFormat` का उपयोग करता है (डिफ़ॉल्ट `audio-24khz-48kbitrate-mono-mp3`)।
  - `node-edge-tts` एक `outputFormat` स्वीकार करता है, लेकिन सभी फ़ॉर्मैट्स
    Edge सेवा से उपलब्ध नहीं होते। citeturn2search0
  - आउटपुट फ़ॉर्मैट मान Microsoft Speech output formats का अनुसरण करते हैं (Ogg/WebM Opus सहित)। citeturn1search0
  - Telegram `sendVoice` OGG/MP3/M4A स्वीकार करता है; यदि आपको
    गारंटीकृत Opus वॉइस नोट्स चाहिए, तो OpenAI/ElevenLabs का उपयोग करें। citeturn1search1
  - यदि विन्यस्त Edge आउटपुट फ़ॉर्मैट विफल होता है, तो OpenClaw MP3 के साथ पुनः प्रयास करता है।

OpenAI/ElevenLabs फ़ॉर्मैट्स स्थिर हैं; वॉइस‑नोट UX के लिए Telegram को Opus अपेक्षित है।

## Auto‑TTS व्यवहार

सक्षम होने पर, OpenClaw:

- यदि उत्तर में पहले से मीडिया या `MEDIA:` निर्देश हो तो TTS छोड़ देता है।
- बहुत छोटे उत्तर (< 10 अक्षर) छोड़ देता है।
- सक्षम होने पर `agents.defaults.model.primary` (या `summaryModel`) का उपयोग करके लंबे उत्तरों का सारांश बनाता है।
- उत्पन्न ऑडियो को उत्तर के साथ संलग्न करता है।

यदि उत्तर `maxLength` से अधिक है और सारांश बंद है (या
सारांश मॉडल के लिए कोई API कुंजी नहीं है), तो ऑडियो
छोड़ दिया जाता है और सामान्य टेक्स्ट उत्तर भेजा जाता है।

## फ़्लो डायग्राम

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

## Slash कमांड उपयोग

एक ही कमांड है: `/tts`।
सक्षम करने के विवरण के लिए [Slash commands](/tools/slash-commands) देखें।

Discord नोट: `/tts` एक बिल्ट‑इन Discord कमांड है, इसलिए OpenClaw वहाँ
`/voice` को नेटिव कमांड के रूप में पंजीकृत करता है। टेक्स्ट `/tts ...` अभी भी काम करता है।

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

नोट्स:

- कमांड्स के लिए अधिकृत प्रेषक आवश्यक है (allowlist/owner नियम लागू रहते हैं)।
- `commands.text` या नेटिव कमांड पंजीकरण सक्षम होना चाहिए।
- `off|always|inbound|tagged` प्रति‑सत्र टॉगल्स हैं (`/tts on` `/tts always` का उपनाम है)।
- `limit` और `summary` स्थानीय prefs में संग्रहीत होते हैं, मुख्य config में नहीं।
- `/tts audio` एक one‑off ऑडियो उत्तर उत्पन्न करता है (TTS को चालू नहीं करता)।

## एजेंट टूल

`tts` टूल टेक्स्ट को स्पीच में बदलता है और एक `MEDIA:` पथ लौटाता है। जब
परिणाम Telegram‑संगत होता है, तो टूल `[[audio_as_voice]]` शामिल करता है ताकि
Telegram वॉइस बबल भेजे।

## Gateway RPC

Gateway मेथड्स:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
