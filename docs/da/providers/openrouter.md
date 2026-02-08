---
summary: "Brug OpenRouters samlede API til at få adgang til mange modeller i OpenClaw"
read_when:
  - Du vil have én enkelt API-nøgle til mange LLM’er
  - Du vil køre modeller via OpenRouter i OpenClaw
title: "OpenRouter"
x-i18n:
  source_path: providers/openrouter.md
  source_hash: b7e29fc9c456c64d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:31Z
---

# OpenRouter

OpenRouter leverer et **samlet API**, der ruter forespørgsler til mange modeller bag ét
endpoint og én API-nøgle. Det er OpenAI-kompatibelt, så de fleste OpenAI-SDK’er virker ved at skifte base-URL.

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
