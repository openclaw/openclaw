---
summary: "Gebruik Xiaomi MiMo (mimo-v2-flash) met OpenClaw"
read_when:
  - Je wilt Xiaomi MiMo-modellen in OpenClaw
  - Je hebt XIAOMI_API_KEY-instelling nodig
title: "Xiaomi MiMo"
x-i18n:
  source_path: providers/xiaomi.md
  source_hash: 366fd2297b2caf8c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:36Z
---

# Xiaomi MiMo

Xiaomi MiMo is het API-platform voor **MiMo**-modellen. Het biedt REST-API's die compatibel zijn met
OpenAI- en Anthropic-formaten en gebruikt API-sleutels voor authenticatie. Maak je API-sleutel aan in
de [Xiaomi MiMo-console](https://platform.xiaomimimo.com/#/console/api-keys). OpenClaw gebruikt
de `xiaomi` provider met een Xiaomi MiMo API-sleutel.

## Modeloverzicht

- **mimo-v2-flash**: contextvenster van 262144 tokens, compatibel met de Anthropic Messages API.
- Basis-URL: `https://api.xiaomimimo.com/anthropic`
- Autorisatie: `Bearer $XIAOMI_API_KEY`

## CLI-installatie

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## Config-fragment

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

## Notities

- Modelreferentie: `xiaomi/mimo-v2-flash`.
- De provider wordt automatisch geïnjecteerd wanneer `XIAOMI_API_KEY` is ingesteld (of wanneer er een authenticatieprofiel bestaat).
- Zie [/concepts/model-providers](/concepts/model-providers) voor providerregels.
