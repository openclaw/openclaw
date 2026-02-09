---
summary: "web_fetch के लिए Firecrawl फ़ॉलबैक (एंटी-बॉट + कैश्ड एक्सट्रैक्शन)"
read_when:
  - आप Firecrawl-आधारित वेब एक्सट्रैक्शन चाहते हैं
  - आपको Firecrawl API कुंजी की आवश्यकता है
  - आप web_fetch के लिए एंटी-बॉट एक्सट्रैक्शन चाहते हैं
title: "Firecrawl"
---

# Firecrawl

OpenClaw `web_fetch` के लिए fallback extractor के रूप में **Firecrawl** का उपयोग कर सकता है। यह एक hosted content extraction सेवा है जो bot circumvention और caching का समर्थन करती है, जो JS-heavy साइट्स या plain HTTP fetches को ब्लॉक करने वाले पेजों के साथ मदद करती है।

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
- `maxAgeMs` नियंत्रित करता है कि cached results कितने पुराने हो सकते हैं (ms)। डिफ़ॉल्ट 2 दिन है।

## स्टेल्थ / बॉट परिहार

Firecrawl बॉट से बचाव के लिए एक **प्रॉक्सी मोड** पैरामीटर प्रदान करता है (`basic`, `stealth`, या `auto`)।
OpenClaw Firecrawl अनुरोधों के लिए हमेशा `proxy: "auto"` के साथ `storeInCache: true` का उपयोग करता है।
यदि प्रॉक्सी छोड़ा जाता है, तो Firecrawl डिफ़ॉल्ट रूप से `auto` का उपयोग करता है। `auto` तब stealth प्रॉक्सी के साथ पुनः प्रयास करता है जब basic प्रयास विफल हो जाता है, जिससे केवल basic स्क्रैपिंग की तुलना में अधिक क्रेडिट उपयोग हो सकते हैं।

## `web_fetch` Firecrawl का उपयोग कैसे करता है

`web_fetch` एक्सट्रैक्शन क्रम:

1. Readability (स्थानीय)
2. Firecrawl (यदि कॉन्फ़िगर किया गया हो)
3. बेसिक HTML क्लीनअप (अंतिम फ़ॉलबैक)

पूरे वेब टूल सेटअप के लिए [Web tools](/tools/web) देखें।
