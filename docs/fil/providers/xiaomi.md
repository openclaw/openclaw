---
summary: "Gamitin ang Xiaomi MiMo (mimo-v2-flash) sa OpenClaw"
read_when:
  - Gusto mo ng mga model ng Xiaomi MiMo sa OpenClaw
  - Kailangan mo ng setup ng XIAOMI_API_KEY
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

13. Ang Xiaomi MiMo ay ang API platform para sa mga **MiMo** model. It provides REST APIs compatible with
    OpenAI and Anthropic formats and uses API keys for authentication. 15. Gumawa ng iyong API key sa [Xiaomi MiMo console](https://platform.xiaomimimo.com/#/console/api-keys). 16. Ginagamit ng OpenClaw ang `xiaomi` provider kasama ang isang Xiaomi MiMo API key.

## Model overview

- **mimo-v2-flash**: 262144-token na context window, compatible sa Anthropic Messages API.
- Base URL: `https://api.xiaomimimo.com/anthropic`
- Authorization: `Bearer $XIAOMI_API_KEY`

## CLI setup

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## Config snippet

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

## Mga tala

- Model ref: `xiaomi/mimo-v2-flash`.
- Awtomatikong ini-inject ang provider kapag naka-set ang `XIAOMI_API_KEY` (o kapag may umiiral na auth profile).
- Tingnan ang [/concepts/model-providers](/concepts/model-providers) para sa mga patakaran ng provider.
