---
title: "Cloudflare AI Gateway"
summary: "Cloudflare AI Gateway सेटअप (प्रमाणीकरण + मॉडल चयन)"
read_when:
  - आप OpenClaw के साथ Cloudflare AI Gateway का उपयोग करना चाहते हैं
  - आपको खाता ID, Gateway ID, या API key पर्यावरण चर की आवश्यकता है
x-i18n:
  source_path: providers/cloudflare-ai-gateway.md
  source_hash: db77652c37652ca2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:31Z
---

# Cloudflare AI Gateway

Cloudflare AI Gateway प्रदाता APIs के सामने स्थित होता है और आपको एनालिटिक्स, कैशिंग, और नियंत्रण जोड़ने देता है। Anthropic के लिए, OpenClaw आपके Gateway एंडपॉइंट के माध्यम से Anthropic Messages API का उपयोग करता है।

- प्रदाता: `cloudflare-ai-gateway`
- बेस URL: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- डिफ़ॉल्ट मॉडल: `cloudflare-ai-gateway/claude-sonnet-4-5`
- API key: `CLOUDFLARE_AI_GATEWAY_API_KEY` (Gateway के माध्यम से अनुरोधों के लिए आपका प्रदाता API key)

Anthropic मॉडलों के लिए, अपनी Anthropic API key का उपयोग करें।

## त्वरित प्रारंभ

1. प्रदाता API key और Gateway विवरण सेट करें:

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. एक डिफ़ॉल्ट मॉडल सेट करें:

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" },
    },
  },
}
```

## गैर-इंटरैक्टिव उदाहरण

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## प्रमाणीकृत Gateway

यदि आपने Cloudflare में Gateway प्रमाणीकरण सक्षम किया है, तो `cf-aig-authorization` हेडर जोड़ें (यह आपकी प्रदाता API key के अतिरिक्त है)।

```json5
{
  models: {
    providers: {
      "cloudflare-ai-gateway": {
        headers: {
          "cf-aig-authorization": "Bearer <cloudflare-ai-gateway-token>",
        },
      },
    },
  },
}
```

## पर्यावरण संबंधी टिप्पणी

यदि Gateway एक डेमन (launchd/systemd) के रूप में चलता है, तो सुनिश्चित करें कि `CLOUDFLARE_AI_GATEWAY_API_KEY` उस प्रक्रिया के लिए उपलब्ध है (उदाहरण के लिए, `~/.openclaw/.env` में या `env.shellEnv` के माध्यम से)।
