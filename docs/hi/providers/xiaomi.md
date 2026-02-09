---
summary: "OpenClaw के साथ Xiaomi MiMo (mimo-v2-flash) का उपयोग करें"
read_when:
  - आप OpenClaw में Xiaomi MiMo मॉडल चाहते हैं
  - आपको XIAOMI_API_KEY सेटअप की आवश्यकता है
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

Xiaomi MiMo is the API platform for **MiMo** models. It provides REST APIs compatible with
OpenAI and Anthropic formats and uses API keys for authentication. Create your API key in
the [Xiaomi MiMo console](https://platform.xiaomimimo.com/#/console/api-keys). OpenClaw uses
the `xiaomi` provider with a Xiaomi MiMo API key.

## मॉडल अवलोकन

- **mimo-v2-flash**: 262144-टोकन कॉन्टेक्स्ट विंडो, Anthropic Messages API संगत।
- Base URL: `https://api.xiaomimimo.com/anthropic`
- Authorization: `Bearer $XIAOMI_API_KEY`

## CLI सेटअप

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## विन्यास स्निपेट

```json5
{
  env: { XIAOMI_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "xiaomi/mimo-v2-flash" } } },
  models: {
    mode: "merge",
    providers: {
      xiaomi: {
        baseUrl: "https://api.xiaomimimo.com/anthropic",
        api: "anthropic-messages",
        apiKey: "XIAOMI_API_KEY",
        models: [
          {
            id: "mimo-v2-flash",
            name: "Xiaomi MiMo V2 Flash",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## नोट्स

- मॉडल संदर्भ: `xiaomi/mimo-v2-flash`।
- जब `XIAOMI_API_KEY` सेट होता है (या कोई auth प्रोफ़ाइल मौजूद हो) तो प्रदाता स्वतः इंजेक्ट हो जाता है।
- प्रदाता नियमों के लिए [/concepts/model-providers](/concepts/model-providers) देखें।
