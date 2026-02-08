---
summary: "Brug Xiaomi MiMo (mimo-v2-flash) med OpenClaw"
read_when:
  - Du vil have Xiaomi MiMo-modeller i OpenClaw
  - Du har brug for opsætning af XIAOMI_API_KEY
title: "Xiaomi MiMo"
x-i18n:
  source_path: providers/xiaomi.md
  source_hash: 366fd2297b2caf8c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:31Z
---

# Xiaomi MiMo

Xiaomi MiMo er API-platformen for **MiMo**-modeller. Den leverer REST-API’er, der er kompatible med
OpenAI- og Anthropic-formater, og bruger API-nøgler til autentificering. Opret din API-nøgle i
[Xiaomi MiMo-konsollen](https://platform.xiaomimimo.com/#/console/api-keys). OpenClaw bruger
udbyderen `xiaomi` med en Xiaomi MiMo API-nøgle.

## Modeloverblik

- **mimo-v2-flash**: 262144-token kontekstvindue, kompatibel med Anthropic Messages API.
- Base-URL: `https://api.xiaomimimo.com/anthropic`
- Autorisation: `Bearer $XIAOMI_API_KEY`

## CLI-opsætning

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## Konfigurationsudsnit

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

## Noter

- Modelreference: `xiaomi/mimo-v2-flash`.
- Udbyderen indsættes automatisk, når `XIAOMI_API_KEY` er sat (eller der findes en godkendelsesprofil).
- Se [/concepts/model-providers](/concepts/model-providers) for regler for udbydere.
