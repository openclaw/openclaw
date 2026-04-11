---
title: "Volcengine (Doubao)"
summary: "Volcano Engine setup (Doubao models, general + coding endpoints)"
read_when:
  - You want to use Volcano Engine or Doubao models with OpenClaw
  - You need the Volcengine API key setup
---

# Volcengine (Doubao)

The Volcengine provider gives access to Doubao models and third-party models
hosted on Volcano Engine, with separate endpoints for general and coding
workloads.

- Providers: `volcengine` (general) + `volcengine-plan` (coding)
- Auth: `VOLCANO_ENGINE_API_KEY`
- API: OpenAI-compatible

## Quick start

1. Set the API key:

```bash
openclaw onboard --auth-choice volcengine-api-key
```

2. Set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "volcengine-plan/ark-code-latest" },
    },
  },
}
```

## Session caching

Enable session-based response caching via the `cache` and `model.api` parameters. The cache
automatically manages `caching`, `thinking`, and `previous_response_id` fields
for multi-turn conversations:

```json5
{
  models: {
    providers: {
      volcengine: {
        api: "openai-responses",
      },
    },
  },
  agents: {
    defaults: {
      models: {
        "volcengine/doubao-seed-2-0-lite-260215": {
          params: {
            cache: {
              enable: true,
              ttlSec: 7200, // cache TTL in seconds (default: 3600)
              thinking: false, // enable thinking (default: true)
            },
          },
        },
      },
    },
  },
}
```

`cache.enable` must be `true` to activate caching. Other fields are optional
and fall back to defaults (`ttlSec: 3600`, `thinking: true`).

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice volcengine-api-key \
  --volcengine-api-key "$VOLCANO_ENGINE_API_KEY"
```

## Providers and endpoints

| Provider          | Endpoint                                  | Use case       |
| ----------------- | ----------------------------------------- | -------------- |
| `volcengine`      | `ark.cn-beijing.volces.com/api/v3`        | General models |
| `volcengine-plan` | `ark.cn-beijing.volces.com/api/coding/v3` | Coding models  |

Both providers are configured from a single API key. Setup registers both
automatically.

## Available models

General provider (`volcengine`):

| Model ref                                    | Name                            | Input       | Context |
| -------------------------------------------- | ------------------------------- | ----------- | ------- |
| `volcengine/doubao-seed-1-8-251228`          | Doubao Seed 1.8                 | text, image | 256,000 |
| `volcengine/doubao-seed-code-preview-251028` | doubao-seed-code-preview-251028 | text, image | 256,000 |
| `volcengine/kimi-k2-5-260127`                | Kimi K2.5                       | text, image | 256,000 |
| `volcengine/glm-4-7-251222`                  | GLM 4.7                         | text, image | 200,000 |
| `volcengine/deepseek-v3-2-251201`            | DeepSeek V3.2                   | text, image | 128,000 |

Coding provider (`volcengine-plan`):

| Model ref                                         | Name                     | Input | Context |
| ------------------------------------------------- | ------------------------ | ----- | ------- |
| `volcengine-plan/ark-code-latest`                 | Ark Coding Plan          | text  | 256,000 |
| `volcengine-plan/doubao-seed-code`                | Doubao Seed Code         | text  | 256,000 |
| `volcengine-plan/glm-4.7`                         | GLM 4.7 Coding           | text  | 200,000 |
| `volcengine-plan/kimi-k2-thinking`                | Kimi K2 Thinking         | text  | 256,000 |
| `volcengine-plan/kimi-k2.5`                       | Kimi K2.5 Coding         | text  | 256,000 |
| `volcengine-plan/doubao-seed-code-preview-251028` | Doubao Seed Code Preview | text  | 256,000 |

`openclaw onboard --auth-choice volcengine-api-key` currently sets
`volcengine-plan/ark-code-latest` as the default model while also registering
the general `volcengine` catalog.

During onboarding/configure model selection, the Volcengine auth choice prefers
both `volcengine/*` and `volcengine-plan/*` rows. If those models are not
loaded yet, OpenClaw falls back to the unfiltered catalog instead of showing an
empty provider-scoped picker.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure
`VOLCANO_ENGINE_API_KEY` is available to that process (for example, in
`~/.openclaw/.env` or via `env.shellEnv`).
