---
summary: "इनबाउंड वॉइस नोट्स के लिए Deepgram ट्रांसक्रिप्शन"
read_when:
  - आप ऑडियो अटैचमेंट्स के लिए Deepgram स्पीच-टू-टेक्स्ट चाहते हैं
  - आपको Deepgram का एक त्वरित विन्यास उदाहरण चाहिए
title: "Deepgram"
---

# Deepgram (ऑडियो ट्रांसक्रिप्शन)

Deepgram is a speech-to-text API. In OpenClaw it is used for **inbound audio/voice note
transcription** via `tools.media.audio`.

When enabled, OpenClaw uploads the audio file to Deepgram and injects the transcript
into the reply pipeline (`{{Transcript}}` + `[Audio]` block). This is **not streaming**;
it uses the pre-recorded transcription endpoint.

वेबसाइट: [https://deepgram.com](https://deepgram.com)  
दस्तावेज़: [https://developers.deepgram.com](https://developers.deepgram.com)

## त्वरित प्रारंभ

1. अपनी एपीआई कुंजी सेट करें:

```
DEEPGRAM_API_KEY=dg_...
```

2. प्रदाता सक्षम करें:

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

## विकल्प

- `model`: Deepgram मॉडल आईडी (डिफ़ॉल्ट: `nova-3`)
- `language`: भाषा संकेत (वैकल्पिक)
- `tools.media.audio.providerOptions.deepgram.detect_language`: भाषा पहचान सक्षम करें (वैकल्पिक)
- `tools.media.audio.providerOptions.deepgram.punctuate`: विराम-चिह्न सक्षम करें (वैकल्पिक)
- `tools.media.audio.providerOptions.deepgram.smart_format`: स्मार्ट फ़ॉर्मैटिंग सक्षम करें (वैकल्पिक)

भाषा के साथ उदाहरण:

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

Deepgram विकल्पों के साथ उदाहरण:

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

## टिप्पणियाँ

- प्रमाणीकरण मानक प्रदाता प्रमाणीकरण क्रम का पालन करता है; `DEEPGRAM_API_KEY` सबसे सरल मार्ग है।
- प्रॉक्सी का उपयोग करते समय `tools.media.audio.baseUrl` और `tools.media.audio.headers` के साथ एंडपॉइंट्स या हेडर्स को ओवरराइड करें।
- आउटपुट अन्य प्रदाताओं के समान ऑडियो नियमों का पालन करता है (आकार सीमाएँ, टाइमआउट्स, ट्रांसक्रिप्ट इंजेक्शन)।
