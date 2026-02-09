---
summary: "Gebruik de uniforme API van OpenRouter om toegang te krijgen tot veel modellen in OpenClaw"
read_when:
  - Je wilt één API-sleutel voor veel LLM's
  - Je wilt modellen via OpenRouter in OpenClaw draaien
title: "OpenRouter"
---

# OpenRouter

OpenRouter biedt een **uniforme API** die verzoeken naar veel modellen routeert achter één
endpoint en API-sleutel. Het is OpenAI-compatibel, dus de meeste OpenAI-SDK's werken door simpelweg de base URL te wijzigen.

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

- Modelverwijzingen zijn `openrouter/<provider>/<model>`.
- Voor meer model-/provideropties, zie [/concepts/model-providers](/concepts/model-providers).
- OpenRouter gebruikt onder de motorkap een Bearer-token met je API-sleutel.
