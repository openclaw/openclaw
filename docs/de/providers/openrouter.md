---
summary: "„Verwenden Sie die einheitliche API von OpenRouter, um in OpenClaw auf viele Modelle zuzugreifen“"
read_when:
  - Sie möchten einen einzelnen API-Schlüssel für viele LLMs
  - Sie möchten Modelle über OpenRouter in OpenClaw ausführen
title: "OpenRouter"
---

# OpenRouter

OpenRouter stellt eine **einheitliche API** bereit, die Anfragen über einen einzelnen
Endpunkt und API-Schlüssel an viele Modelle weiterleitet. Sie ist OpenAI-kompatibel, sodass die meisten OpenAI-SDKs durch das Umschalten der Basis-URL funktionieren.

## CLI setup

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## Config snippet

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

## Notes

- Modell-Referenzen sind `openrouter/<provider>/<model>`.
- Weitere Modell-/Anbieteroptionen finden Sie unter [/concepts/model-providers](/concepts/model-providers).
- OpenRouter verwendet intern ein Bearer-Token mit Ihrem API-Schlüssel.
