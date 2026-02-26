---
summary: "Configure StepFun Step 3.5 Flash in OpenClaw"
read_when:
  - You want to use StepFun in OpenClaw
  - You need the provider id, model ref, and config snippet
title: "StepFun"
---

# StepFun

StepFun is an AI company that develops the Step model family, including
`Step-3.5-Flash`. In OpenClaw, use the `stepfun` provider and model refs like
`stepfun/step-3.5-flash`.

StepFun provides OpenAI-compatible endpoints, so onboarding and manual config
follow the same `models.providers` pattern used by other OpenAI-compatible
providers.

## Why people use it

- `Step-3.5-Flash` can be a good fit for fast interactive and agentic
  workflows (tool loops, iterative planning, code tasks), especially when you
  prefer lower latency than larger reasoning-heavy models.
- Model card (Hugging Face):
  [stepfun-ai/Step-3.5-Flash](https://huggingface.co/stepfun-ai/Step-3.5-Flash)

## CLI setup

Interactive onboarding:

```bash
openclaw onboard --auth-choice stepfun-api-key
```

Non-interactive onboarding:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice stepfun-api-key \
  --stepfun-api-key "$STEPFUN_API_KEY"
```

## Config snippet

```json5
{
  env: { STEPFUN_API_KEY: "your-stepfun-api-key" },
  agents: {
    defaults: {
      model: {
        primary: "stepfun/step-3.5-flash",
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      stepfun: {
        baseUrl: "https://api.stepfun.ai/v1",
        apiKey: "${STEPFUN_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "step-3.5-flash",
            name: "Step 3.5 Flash",
          },
        ],
      },
    },
  },
}
```

## Notes

- OpenClaw onboarding writes `models.providers.stepfun` automatically.
- Model refs use `stepfun/<modelId>`.
- If you need a different compatible endpoint later, update
  `models.providers.stepfun.baseUrl` manually.
