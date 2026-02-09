---
summary: "web_search के लिए Perplexity Sonar सेटअप"
read_when:
  - आप वेब खोज के लिए Perplexity Sonar का उपयोग करना चाहते हैं
  - आपको PERPLEXITY_API_KEY या OpenRouter सेटअप की आवश्यकता है
title: "Perplexity Sonar"
---

# Perplexity Sonar

आप Perplexity की direct API के माध्यम से या OpenRouter के ज़रिए कनेक्ट कर सकते हैं। State, OpenClaw state directory के अंतर्गत रहता है।

## एपीआई विकल्प

### Perplexity (सीधा)

- Base URL: [https://api.perplexity.ai](https://api.perplexity.ai)
- Environment variable: `PERPLEXITY_API_KEY`

### OpenRouter (वैकल्पिक)

- Base URL: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- Environment variable: `OPENROUTER_API_KEY`
- प्रीपेड/क्रिप्टो क्रेडिट का समर्थन करता है।

## विन्यास उदाहरण

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## Brave से स्विच करना

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
        },
      },
    },
  },
}
```

यदि `PERPLEXITY_API_KEY` और `OPENROUTER_API_KEY` दोनों सेट हैं, तो अस्पष्टता दूर करने के लिए
`tools.web.search.perplexity.baseUrl` (या `tools.web.search.perplexity.apiKey`) सेट करें।

यदि कोई Base URL सेट नहीं है, तो OpenClaw API कुंजी के स्रोत के आधार पर डिफ़ॉल्ट चुनता है:

- `PERPLEXITY_API_KEY` या `pplx-...` → सीधा Perplexity (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` या `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- अज्ञात कुंजी फ़ॉर्मैट → OpenRouter (सुरक्षित फ़ॉलबैक)

## मॉडल

- `perplexity/sonar` — वेब खोज के साथ तेज़ Q&A
- `perplexity/sonar-pro` (डिफ़ॉल्ट) — बहु-चरणीय तर्क + वेब खोज
- `perplexity/sonar-reasoning-pro` — गहन शोध

पूर्ण web_search विन्यास के लिए [Web tools](/tools/web) देखें।
