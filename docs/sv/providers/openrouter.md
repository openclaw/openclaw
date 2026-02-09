---
summary: "Använd OpenRouters enhetliga API för att få åtkomst till många modeller i OpenClaw"
read_when:
  - Du vill ha en enda API-nyckel för många LLM:er
  - Du vill köra modeller via OpenRouter i OpenClaw
title: "OpenRouter"
---

# OpenRouter

OpenRouter tillhandahåller ett **enhetligt API** som rutter begär till många modeller bakom en enda
slutpunkt och API-nyckel. Det är OpenAI-kompatibelt, så de flesta OpenAI SDKs fungerar genom att byta bas-URL.

## CLI-konfigurering

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## Konfigutdrag

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

## Noteringar

- Modellreferenser är `openrouter/<provider>/<model>`.
- För fler modell-/leverantörsalternativ, se [/concepts/model-providers](/concepts/model-providers).
- OpenRouter använder en Bearer-token med din API-nyckel under huven.
