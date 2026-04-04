---
summary: "Use OpenRouter's unified API to access many models in OpenClaw"
read_when:
  - You want a single API key for many LLMs
  - You want to run models via OpenRouter in OpenClaw
title: "OpenRouter"
---

# OpenRouter

OpenRouter provides a **unified API** that routes requests to many models behind a single
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

## CLI setup

```bash
openclaw onboard --auth-choice openrouter-api-key
```

## Config snippet

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/auto" },
    },
  },
}
```

## Notes

- Model refs are `openrouter/<provider>/<model>`.
- Onboarding defaults to `openrouter/auto`. Switch to a concrete model later with
  `openclaw models set openrouter/<provider>/<model>`.
- For more model/provider options, see [/concepts/model-providers](/concepts/model-providers).
- OpenRouter uses a Bearer token with your API key under the hood.
- On real OpenRouter requests (`https://openrouter.ai/api/v1`), OpenClaw also
  adds OpenRouter's documented app-attribution headers:
  `HTTP-Referer: https://openclaw.ai`, `X-OpenRouter-Title: OpenClaw`, and
  `X-OpenRouter-Categories: cli-agent`.
- On verified OpenRouter routes, Anthropic model refs also keep the
  OpenRouter-specific Anthropic `cache_control` markers that OpenClaw uses for
  better prompt-cache reuse on system/developer prompt blocks.
- If you repoint the OpenRouter provider at some other proxy/base URL, OpenClaw
  does not inject those OpenRouter-specific headers or Anthropic cache markers.
- OpenRouter still runs through the proxy-style OpenAI-compatible path, so
  native OpenAI-only request shaping such as `serviceTier`, Responses `store`,
  OpenAI reasoning-compat payloads, and prompt-cache hints is not forwarded.
