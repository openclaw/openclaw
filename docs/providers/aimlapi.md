---
summary: "Use AIMLAPI for OpenClaw models with a single API key"
read_when:
  - You want to use AIMLAPI with OpenClaw
  - You need to configure an AIMLAPI API key
title: "AIMLAPI"
---

# AIMLAPI

AIMLAPI provides a unified API key for multiple models. In OpenClaw, AIMLAPI models
use the `aimlapi/<provider>/<model>` format.

## Get an API key

Create a key at [aimlapi.com/app/keys](https://aimlapi.com/app/keys/). Keep the key handy for the CLI or config.

## CLI setup

```bash
openclaw onboard --auth-choice apiKey --token-provider aimlapi --token "$AIMLAPI_API_KEY"
```

## Config snippet

```json5
{
  env: { AIMLAPI_API_KEY: "sk-aimlapi-..." },
  agents: {
    defaults: {
      model: { primary: "aimlapi/openai/gpt-5-nano-2025-08-07" },
    },
  },
}
```

## Notes

- Use `AIMLAPI_API_KEY` in your gateway environment or config.
- For model/provider options, see [/concepts/model-providers](/concepts/model-providers).
