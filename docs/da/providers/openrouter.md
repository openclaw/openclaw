---
summary: "Brug OpenRouters samlede API til at få adgang til mange modeller i OpenClaw"
read_when:
  - Du vil have én enkelt API-nøgle til mange LLM’er
  - Du vil køre modeller via OpenRouter i OpenClaw
title: "OpenRouter"
---

# OpenRouter

OpenRouter giver en \*\* samlet API\*\* at ruter anmoder om til mange modeller bag en enkelt
endpoint og API-nøgle. Det er OpenAI-kompatibelt, så de fleste OpenAI SDKs virker ved at skifte grund-URL.

## CLI-opsætning

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## Konfigurationsudsnit

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
    },
  },
}
```

## Noter

- Modelreferencer er `openrouter/<provider>/<model>`.
- For flere model-/udbydermuligheder, se [/concepts/model-providers](/concepts/model-providers).
- OpenRouter bruger et Bearer-token med din API-nøgle under motorhjelmen.
