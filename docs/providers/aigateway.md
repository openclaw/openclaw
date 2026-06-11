---
summary: "Use AIgateway's OpenAI-compatible API with OpenClaw"
read_when:
  - You want to run OpenClaw with AIgateway models
  - You need the AIgateway provider id, key, or endpoint
title: "AIgateway"
---

AIgateway is a hosted AI model gateway that exposes many model families behind
one OpenAI-compatible API and one API key. In OpenClaw it is a bundled model
provider, which means you can select it with the provider id `aigateway`, store
credentials through normal model auth, and use model refs like
`aigateway/openai/gpt-5.5`.

Use AIgateway when you want one API key for several hosted model families,
including OpenAI, Anthropic, and Google routes exposed by AIgateway's catalog.
It is useful as a secondary provider for model fallback, for comparing hosted
routes across vendors, or when AIgateway has a model available before your
primary provider does.

This provider uses OpenAI-compatible chat semantics. OpenClaw owns the provider
id, auth profile, model catalog seed, and base URL; AIgateway owns the live
model availability, billing, rate limits, and any provider-side routing policy.

## Setup

Create an API key in AIgateway, then run:

```bash
openclaw onboard --auth-choice aigateway-api-key
```

Or set:

```bash
export AIGATEWAY_API_KEY="<your-aigateway-api-key>" # pragma: allowlist secret
```

## Defaults

- Provider: `aigateway`
- Base URL: `https://api.aigateway.sh/v1`
- Env var: `AIGATEWAY_API_KEY`
- Default model: `aigateway/openai/gpt-5.5`

Example config:

```json
{
  "agents": {
    "defaults": {
      "model": { "primary": "aigateway/openai/gpt-5.5" }
    }
  }
}
```

## When to choose AIgateway

- You want a hosted OpenAI-compatible endpoint rather than a local model server.
- You want to try several commercial model families through one provider
  account and one API key.
- You want a fallback provider with different upstream routing from OpenRouter,
  Cloudflare AI Gateway, Vercel AI Gateway, or the direct vendor APIs.
- You need AIgateway-specific model ids, pricing, or account controls.

Choose the direct vendor provider instead when you need vendor-native features
that AIgateway does not expose through its OpenAI-compatible route. Choose a
local provider such as Ollama, LM Studio, vLLM, or SGLang when data locality or
local GPU control matters more than hosted convenience.

## Models

AIgateway model ids keep the upstream vendor prefix, so the OpenClaw model ref
is `aigateway/<vendor>/<model>`. The bundled catalog seeds commonly available
AIgateway route ids, including:

- `aigateway/openai/gpt-5.5`
- `aigateway/anthropic/claude-opus-4.8`
- `aigateway/google/gemini-3.1-pro`
- `aigateway/moonshot/kimi-k2.6`

The catalog is a seed, not a promise that every account can call every model at
all times. Use OpenClaw's model listing command to see what the configured
provider reports in your environment:

```bash
openclaw models list --provider aigateway
```

## Troubleshooting

- `401` or `403`: check that `AIGATEWAY_API_KEY` is set for the process running
  OpenClaw, or re-run onboarding to store the key in the provider auth profile.
- Unknown model errors: confirm the model exists in your AIgateway account and
  use the full `aigateway/<vendor>/<model>` ref shown by
  `openclaw models list --provider aigateway`.
- Intermittent provider errors: try a different AIgateway route or configure
  AIgateway as a fallback rather than the only primary model provider.

## Related

- [Model providers](/concepts/model-providers)
- [All providers](/providers/index)
