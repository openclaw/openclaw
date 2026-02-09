---
title: "Vercel AI Gateway"
summary: "Vercel AI Gateway सेटअप (प्रमाणीकरण + मॉडल चयन)"
read_when:
  - आप OpenClaw के साथ Vercel AI Gateway का उपयोग करना चाहते हैं
  - आपको API कुंजी पर्यावरण चर या CLI प्रमाणीकरण विकल्प की आवश्यकता है
---

# Vercel AI Gateway

[Vercel AI Gateway](https://vercel.com/ai-gateway) एक एकीकृत API प्रदान करता है, जिसके माध्यम से एक ही एंडपॉइंट से सैकड़ों मॉडलों तक पहुँच की जा सकती है।

- प्रदाता: `vercel-ai-gateway`
- प्रमाणीकरण: `AI_GATEWAY_API_KEY`
- API: Anthropic Messages संगत

## त्वरित प्रारंभ

1. API कुंजी सेट करें (अनुशंसित: इसे Gateway के लिए सहेजें):

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. एक डिफ़ॉल्ट मॉडल सेट करें:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## गैर-इंटरैक्टिव उदाहरण

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## पर्यावरण संबंधी टिप्पणी

यदि Gateway एक डेमन के रूप में चलता है (launchd/systemd), तो सुनिश्चित करें कि `AI_GATEWAY_API_KEY`
उस प्रक्रिया के लिए उपलब्ध हो (उदाहरण के लिए, `~/.openclaw/.env` में या
`env.shellEnv` के माध्यम से)।
