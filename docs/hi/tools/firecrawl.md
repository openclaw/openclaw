---
summary: "web_fetch के लिए Firecrawl फ़ॉलबैक (एंटी-बॉट + कैश्ड एक्सट्रैक्शन)"
read_when:
  - आप Firecrawl-आधारित वेब एक्सट्रैक्शन चाहते हैं
  - आपको Firecrawl API कुंजी की आवश्यकता है
  - आप web_fetch के लिए एंटी-बॉट एक्सट्रैक्शन चाहते हैं
title: "Firecrawl"
x-i18n:
  source_path: tools/firecrawl.md
  source_hash: 08a7ad45b41af412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:46Z
---

# Firecrawl

OpenClaw, `web_fetch` के लिए फ़ॉलबैक एक्सट्रैक्टर के रूप में **Firecrawl** का उपयोग कर सकता है। यह एक होस्टेड
कंटेंट एक्सट्रैक्शन सेवा है जो बॉट परिहार और कैशिंग का समर्थन करती है, जो
JS-भारी साइटों या उन पृष्ठों के लिए सहायक है जो साधारण HTTP फ़ेच को ब्लॉक करते हैं।

## API कुंजी प्राप्त करें

1. एक Firecrawl खाता बनाएँ और एक API कुंजी जनरेट करें।
2. इसे विन्यास में सहेजें या Gateway वातावरण में `FIRECRAWL_API_KEY` सेट करें।

## Firecrawl कॉन्फ़िगर करें

```json5
{
  tools: {
    web: {
      fetch: {
        firecrawl: {
          apiKey: "FIRECRAWL_API_KEY_HERE",
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 172800000,
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

नोट्स:

- `firecrawl.enabled` API कुंजी मौजूद होने पर डिफ़ॉल्ट रूप से true होता है।
- `maxAgeMs` यह नियंत्रित करता है कि कैश्ड परिणाम कितने पुराने हो सकते हैं (ms)। डिफ़ॉल्ट 2 दिन है।

## स्टेल्थ / बॉट परिहार

Firecrawl बॉट परिहार के लिए **proxy mode** पैरामीटर प्रदान करता है (`basic`, `stealth`, या `auto`)।
OpenClaw Firecrawl अनुरोधों के लिए हमेशा `proxy: "auto"` के साथ `storeInCache: true` का उपयोग करता है।
यदि proxy छोड़ा जाता है, तो Firecrawl डिफ़ॉल्ट रूप से `auto` का उपयोग करता है। `auto` तब स्टेल्थ प्रॉक्सीज़ के साथ पुनः प्रयास करता है यदि एक बुनियादी प्रयास विफल हो जाए, जो
केवल-बेसिक स्क्रैपिंग की तुलना में अधिक क्रेडिट उपयोग कर सकता है।

## `web_fetch` Firecrawl का उपयोग कैसे करता है

`web_fetch` एक्सट्रैक्शन क्रम:

1. Readability (स्थानीय)
2. Firecrawl (यदि कॉन्फ़िगर किया गया हो)
3. बेसिक HTML क्लीनअप (अंतिम फ़ॉलबैक)

पूरे वेब टूल सेटअप के लिए [Web tools](/tools/web) देखें।
