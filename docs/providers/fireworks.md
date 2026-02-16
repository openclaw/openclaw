---
summary: "Use Fireworks AI models in OpenClaw (API key + OpenAI-compatible endpoint)"
read_when:
  - You want to use Fireworks as your model provider
  - You need FIREWORKS_API_KEY onboarding and config examples
title: "Fireworks AI"
---

# Fireworks AI

Fireworks provides an OpenAI-compatible inference API for many hosted models.
OpenClaw supports Fireworks as a built-in onboarding provider (`fireworks`).

## CLI setup

```bash
openclaw onboard --auth-choice fireworks-api-key
# or non-interactive
openclaw onboard --non-interactive \
  --auth-choice fireworks-api-key \
  --fireworks-api-key "$FIREWORKS_API_KEY"
```

## Config snippet

```json5
{
  env: { FIREWORKS_API_KEY: "fw_..." },
  agents: {
    defaults: {
      model: { primary: "fireworks/accounts/fireworks/models/llama-v3p1-8b-instruct" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      fireworks: {
        baseUrl: "https://api.fireworks.ai/inference/v1",
        api: "openai-completions",
        apiKey: "${FIREWORKS_API_KEY}",
      },
    },
  },
}
```

## Notes

- Default model ref: `fireworks/accounts/fireworks/models/llama-v3p1-8b-instruct`.
- Base URL: `https://api.fireworks.ai/inference/v1`.
- Auth env var: `FIREWORKS_API_KEY`.
- For provider-wide rules, see [/concepts/model-providers](/concepts/model-providers).
