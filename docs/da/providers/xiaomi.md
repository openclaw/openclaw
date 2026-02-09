---
summary: "Brug Xiaomi MiMo (mimo-v2-flash) med OpenClaw"
read_when:
  - Du vil have Xiaomi MiMo-modeller i OpenClaw
  - Du har brug for opsætning af XIAOMI_API_KEY
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

Xiaomi MiMo er API-platformen for **MiMo** modeller. Det giver REST API'er kompatible med
OpenAI og Antropiske formater og bruger API-nøgler til godkendelse. Opret din API-nøgle i
[Xiaomi MiMo-konsollen](https://platform.xiaomimimo.com/#/console/api-keys). OpenClaw bruger
`xiaomi` udbyder med en Xiaomi MiMo API-nøgle.

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
