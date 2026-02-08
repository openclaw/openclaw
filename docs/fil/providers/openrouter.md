---
summary: "Gamitin ang pinag-isang API ng OpenRouter para ma-access ang maraming model sa OpenClaw"
read_when:
  - Gusto mo ng iisang API key para sa maraming LLM
  - Gusto mong patakbuhin ang mga model sa pamamagitan ng OpenRouter sa OpenClaw
title: "OpenRouter"
x-i18n:
  source_path: providers/openrouter.md
  source_hash: b7e29fc9c456c64d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:43Z
---

# OpenRouter

Nagbibigay ang OpenRouter ng **pinag-isang API** na niruruta ang mga request sa maraming model sa likod ng iisang
endpoint at API key. Compatible ito sa OpenAI, kaya gumagana ang karamihan ng OpenAI SDK sa pamamagitan ng pagpapalit ng base URL.

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
