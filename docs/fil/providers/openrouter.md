---
summary: "Gamitin ang pinag-isang API ng OpenRouter para ma-access ang maraming model sa OpenClaw"
read_when:
  - Gusto mo ng iisang API key para sa maraming LLM
  - Gusto mong patakbuhin ang mga model sa pamamagitan ng OpenRouter sa OpenClaw
title: "OpenRouter"
---

# OpenRouter

OpenRouter provides a **unified API** that routes requests to many models behind a single
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

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

## Mga tala

- Ang mga model ref ay `openrouter/<provider>/<model>`.
- Para sa higit pang opsyon sa model/provider, tingnan ang [/concepts/model-providers](/concepts/model-providers).
- Gumagamit ang OpenRouter ng Bearer token kasama ang iyong API key sa ilalim ng hood.
