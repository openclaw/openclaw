---
summary: "OpenClaw के साथ Xiaomi MiMo (mimo-v2-flash) का उपयोग करें"
read_when:
  - आप OpenClaw में Xiaomi MiMo मॉडल चाहते हैं
  - आपको XIAOMI_API_KEY सेटअप की आवश्यकता है
title: "Xiaomi MiMo"
x-i18n:
  source_path: providers/xiaomi.md
  source_hash: 366fd2297b2caf8c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:33Z
---

# Xiaomi MiMo

Xiaomi MiMo **MiMo** मॉडलों के लिए API प्लेटफ़ॉर्म है। यह
OpenAI और Anthropic फ़ॉर्मैट्स के साथ संगत REST APIs प्रदान करता है और प्रमाणीकरण के लिए API कुंजियों का उपयोग करता है। अपनी API कुंजी
[Xiaomi MiMo कंसोल](https://platform.xiaomimimo.com/#/console/api-keys) में बनाएँ। OpenClaw
Xiaomi MiMo API कुंजी के साथ `xiaomi` प्रदाता का उपयोग करता है।

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
