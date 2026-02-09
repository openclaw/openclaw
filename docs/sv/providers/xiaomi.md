---
summary: "Använd Xiaomi MiMo (mimo-v2-flash) med OpenClaw"
read_when:
  - Du vill använda Xiaomi MiMo‑modeller i OpenClaw
  - Du behöver konfigurera XIAOMI_API_KEY
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

Xiaomi MiMo är API-plattformen för **MiMo**-modeller. Det ger REST API:er kompatibla med
OpenAI och Anthropic format och använder API-nycklar för autentisering. Skapa din API-nyckel i
[Xiaomi MiMo-konsolen](https://platform.xiaomimimo.com/#/console/api-keys). OpenClaw använder
leverantören `xiaomi` med en Xiaomi MiMo API-nyckel.

## Modellöversikt

- **mimo-v2-flash**: 262 144‑tokeners kontextfönster, kompatibel med Anthropic Messages API.
- Bas‑URL: `https://api.xiaomimimo.com/anthropic`
- Auktorisering: `Bearer $XIAOMI_API_KEY`

## CLI‑konfigurering

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## Konfigutdrag

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

## Noteringar

- Modellreferens: `xiaomi/mimo-v2-flash`.
- Leverantören injiceras automatiskt när `XIAOMI_API_KEY` är inställd (eller när en autentiseringsprofil finns).
- Se [/concepts/model-providers](/concepts/model-providers) för leverantörsregler.
