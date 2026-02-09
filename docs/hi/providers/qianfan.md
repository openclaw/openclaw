---
summary: "OpenClaw में अनेक मॉडलों तक पहुँचने के लिए Qianfan के एकीकृत API का उपयोग करें"
read_when:
  - आप कई LLMs के लिए एक ही API कुंजी चाहते हैं
  - आपको Baidu Qianfan सेटअप मार्गदर्शन की आवश्यकता है
title: "Qianfan"
---

# Qianfan प्रदाता मार्गदर्शिका

Qianfan is Baidu's MaaS platform, provides a **unified API** that routes requests to many models behind a single
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

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
