---
summary: "web_search के लिए Brave Search API सेटअप"
read_when:
  - आप web_search के लिए Brave Search का उपयोग करना चाहते हैं
  - आपको BRAVE_API_KEY या प्लान विवरण की आवश्यकता है
title: "Brave Search"
---

# Brave Search API

OpenClaw `web_search` के लिए डिफ़ॉल्ट प्रदाता के रूप में Brave Search का उपयोग करता है।

## API कुंजी प्राप्त करें

1. [https://brave.com/search/api/](https://brave.com/search/api/) पर Brave Search API खाता बनाएँ
2. डैशबोर्ड में, **Data for Search** प्लान चुनें और एक API कुंजी जनरेट करें।
3. कुंजी को config में संग्रहीत करें (अनुशंसित) या Gateway environment में `BRAVE_API_KEY` सेट करें।

## Config उदाहरण

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

## नोट्स

- Data for AI प्लान `web_search` के साथ **संगत नहीं** है।
- Brave एक मुफ़्त टियर के साथ-साथ भुगतान किए गए प्लान भी प्रदान करता है; वर्तमान सीमाओं के लिए Brave API पोर्टल देखें।

पूर्ण web_search विन्यास के लिए [Web tools](/tools/web) देखें।
