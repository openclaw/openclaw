---
summary: "इनबाउंड वॉइस नोट्स के लिए Deepgram ट्रांसक्रिप्शन"
read_when:
  - आप ऑडियो अटैचमेंट्स के लिए Deepgram स्पीच-टू-टेक्स्ट चाहते हैं
  - आपको Deepgram का एक त्वरित विन्यास उदाहरण चाहिए
title: "Deepgram"
x-i18n:
  source_path: providers/deepgram.md
  source_hash: dabd1f6942c339fb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:33Z
---

# Deepgram (ऑडियो ट्रांसक्रिप्शन)

Deepgram एक स्पीच-टू-टेक्स्ट API है। OpenClaw में इसका उपयोग **इनबाउंड ऑडियो/वॉइस नोट
ट्रांसक्रिप्शन** के लिए `tools.media.audio` के माध्यम से किया जाता है।

सक्षम होने पर, OpenClaw ऑडियो फ़ाइल को Deepgram पर अपलोड करता है और ट्रांसक्रिप्ट को
रिप्लाई पाइपलाइन में सम्मिलित करता है (`{{Transcript}}` + `[Audio]` ब्लॉक)। यह **स्ट्रीमिंग नहीं** है;
यह प्री-रिकॉर्डेड ट्रांसक्रिप्शन एंडपॉइंट का उपयोग करता है।

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
