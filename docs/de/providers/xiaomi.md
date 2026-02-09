---
summary: "„Xiaomi MiMo (mimo-v2-flash) mit OpenClaw verwenden“"
read_when:
  - Sie möchten Xiaomi‑MiMo‑Modelle in OpenClaw nutzen
  - Sie benötigen die Einrichtung von XIAOMI_API_KEY
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

Xiaomi MiMo ist die API‑Plattform für **MiMo**‑Modelle. Sie stellt REST‑APIs bereit, die mit den
Formaten von OpenAI und Anthropic kompatibel sind, und verwendet API‑Schlüssel zur
Authentifizierung. Erstellen Sie Ihren API‑Schlüssel in der
[Xiaomi‑MiMo‑Konsole](https://platform.xiaomimimo.com/#/console/api-keys). OpenClaw verwendet
den Anbieter `xiaomi` mit einem Xiaomi‑MiMo‑API‑Schlüssel.

## Modellübersicht

- **mimo-v2-flash**: 262.144‑Token‑Kontextfenster, kompatibel mit der Anthropic Messages API.
- Basis‑URL: `https://api.xiaomimimo.com/anthropic`
- Autorisierung: `Bearer $XIAOMI_API_KEY`

## CLI‑Einrichtung

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## Konfigurationsausschnitt

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

## Hinweise

- Modell‑Referenz: `xiaomi/mimo-v2-flash`.
- Der Anbieter wird automatisch injiziert, wenn `XIAOMI_API_KEY` gesetzt ist (oder ein Auth‑Profil existiert).
- Siehe [/concepts/model-providers](/concepts/model-providers) für Anbieterregeln.
