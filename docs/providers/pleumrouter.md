---
summary: "Use PleumRouter's OpenAI-compatible API with OpenClaw"
read_when:
  - You want to run OpenClaw through PleumRouter
  - You need the PleumRouter provider id, key, or endpoint
title: "PleumRouter"
---

PleumRouter is a Korea-region multi-provider LLM gateway with an OpenAI-compatible API.
It ships as a bundled OpenClaw provider (no separate plugin install), so credentials go
through the normal model auth flow and model refs look like `pleumrouter/deepseek-v4-pro`.

## Setup

Create an API key at [router.pleum.ai](https://router.pleum.ai) (Dashboard → API Keys), then run:

```bash
openclaw onboard --auth-choice pleumrouter-api-key
```

Or set:

```bash
export PLEUMROUTER_API_KEY="<your-pleumrouter-api-key>" # pragma: allowlist secret
```

## Defaults

| Setting       | Value                              |
| ------------- | ---------------------------------- |
| Provider id   | `pleumrouter`                      |
| Aliases       | `pleum`, `pleum-router`            |
| Base URL      | `https://router.pleum.ai/v1`       |
| Env var       | `PLEUMROUTER_API_KEY`              |
| Default model | `pleumrouter/deepseek-v4-pro`      |

## Bundled model catalog

- `pleumrouter/deepseek-v4-pro`
- `pleumrouter/glm-5.1`
- `pleumrouter/qwen3-max`
- `pleumrouter/claude-sonnet-4-6`
- `pleumrouter/gpt-5.5`
- `pleumrouter/gemini-2.5-pro`

This is a starting point, not a live catalog. Your account or PleumRouter's
current offering may add, remove, or restrict routes. Check before setting a
long-lived default:

```bash
openclaw models list --provider pleumrouter
```

## When to choose PleumRouter

- One API key for many upstream providers (OpenAI, Anthropic, Google, and more)
- KRW prepaid credits / Korea-region gateway with PIPA-aware operation
- OpenAI-compatible drop-in (`base_url` + key) without per-provider key sprawl

Choose a direct vendor provider when you need vendor-native request parameters
or support contracts.

## Troubleshooting

- `401`/`403`: verify the key in the PleumRouter dashboard and re-run
  `openclaw onboard --auth-choice pleumrouter-api-key` if the stored profile is stale.
- Unknown model errors: use the exact `pleumrouter/<model-id>` returned by
  `openclaw models list --provider pleumrouter`.

## Related

- [Model providers](/concepts/model-providers)
- [Agent integration cookbook](https://router.pleum.ai/docs/cookbook/agent-integration)
