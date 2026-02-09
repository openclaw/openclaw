---
summary: "Korzystaj z Xiaomi MiMo (mimo-v2-flash) w OpenClaw"
read_when:
  - Chcesz używać modeli Xiaomi MiMo w OpenClaw
  - Potrzebujesz konfiguracji XIAOMI_API_KEY
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

Xiaomi MiMo to platforma API dla modeli **MiMo**. Udostępnia interfejsy API REST zgodne z
formatami OpenAI i Anthropic oraz używa kluczy API do uwierzytelniania. Utwórz swój klucz API w
[konsoli Xiaomi MiMo](https://platform.xiaomimimo.com/#/console/api-keys). OpenClaw korzysta z
dostawcy `xiaomi` z kluczem API Xiaomi MiMo.

## Przegląd modeli

- **mimo-v2-flash**: okno kontekstu 262144 tokenów, zgodny z Anthropic Messages API.
- Bazowy URL: `https://api.xiaomimimo.com/anthropic`
- Autoryzacja: `Bearer $XIAOMI_API_KEY`

## konfiguracja CLI

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## Fragment konfiguracji

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

## Uwagi

- Odwołanie do modelu: `xiaomi/mimo-v2-flash`.
- Dostawca jest wstrzykiwany automatycznie, gdy ustawiono `XIAOMI_API_KEY` (lub istnieje profil uwierzytelniania).
- Zobacz [/concepts/model-providers](/concepts/model-providers), aby poznać zasady dotyczące dostawców.
