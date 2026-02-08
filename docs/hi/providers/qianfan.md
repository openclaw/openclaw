---
summary: "OpenClaw में अनेक मॉडलों तक पहुँचने के लिए Qianfan के एकीकृत API का उपयोग करें"
read_when:
  - आप कई LLMs के लिए एक ही API कुंजी चाहते हैं
  - आपको Baidu Qianfan सेटअप मार्गदर्शन की आवश्यकता है
title: "Qianfan"
x-i18n:
  source_path: providers/qianfan.md
  source_hash: 2ca710b422f190b6
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:34Z
---

# Qianfan प्रदाता मार्गदर्शिका

Qianfan, Baidu का MaaS प्लेटफ़ॉर्म है, जो एक **एकीकृत API** प्रदान करता है और एक ही
एंडपॉइंट और API कुंजी के पीछे कई मॉडलों तक अनुरोधों को रूट करता है। यह OpenAI-संगत है, इसलिए
बेस URL बदलकर अधिकांश OpenAI SDKs काम करते हैं।

## पूर्वापेक्षाएँ

1. Qianfan API एक्सेस के साथ एक Baidu Cloud खाता
2. Qianfan कंसोल से एक API कुंजी
3. आपके सिस्टम पर OpenClaw स्थापित होना

## अपनी API कुंजी प्राप्त करना

1. [Qianfan कंसोल](https://console.bce.baidu.com/qianfan/ais/console/apiKey) पर जाएँ
2. एक नया एप्लिकेशन बनाएँ या किसी मौजूदा का चयन करें
3. एक API कुंजी जनरेट करें (फ़ॉर्मेट: `bce-v3/ALTAK-...`)
4. OpenClaw के साथ उपयोग के लिए API कुंजी कॉपी करें

## CLI सेटअप

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## संबंधित दस्तावेज़

- [OpenClaw विन्यास](/gateway/configuration)
- [मॉडल प्रदाता](/concepts/model-providers)
- [एजेंट सेटअप](/concepts/agent)
- [Qianfan API दस्तावेज़](/https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
