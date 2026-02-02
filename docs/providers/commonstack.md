---
summary: "Use CommonStack's AI inference platform to access multiple models in OpenClaw"
read_when:
  - You want to use CommonStack's model marketplace
  - You want to access models via CommonStack in OpenClaw
title: "CommonStack"
---

# CommonStack

CommonStack provides an **AI model marketplace** that offers access to various models behind a unified
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

## CLI setup

```bash
openclaw onboard --auth-choice commonstack-api-key --commonstack-api-key "$COMMONSTACK_API_KEY"
```

Or with environment variable:

```bash
export COMMONSTACK_API_KEY="sk-your-api-key"
openclaw onboard --auth-choice commonstack-api-key
```

## Config snippet

```json5
{
  env: { COMMONSTACK_API_KEY: "sk-..." },
  models: {
    providers: {
      commonstack: {
        baseUrl: "https://api.commonstack.ai/v1",
        api: "openai-completions",
        headers: {
          "User-Agent": "https://openclaw.ai",
        },
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "commonstack/openai/gpt-oss-120b" },
    },
  },
}
```

## Model scanning

CommonStack does not have a default auto-routing model like OpenRouter. You need to scan and select a model:

```bash
# Scan available models
openclaw models scan --scan-provider commonstack

# Scan with tool capability probing
openclaw models scan --scan-provider commonstack --probe

# Scan and set as default model
openclaw models scan --scan-provider commonstack --set-default
```

## Notes

- Model refs are `commonstack/<model_id>` (e.g., `commonstack/openai/gpt-oss-120b`).
- CommonStack requires a custom `User-Agent` header (`https://openclaw.ai`) for API calls.
- For more model/provider options, see [/concepts/model-providers](/concepts/model-providers).
- CommonStack uses Bearer token authentication with your API key.
