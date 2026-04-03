---
summary: "Use StepFun models with OpenClaw"
read_when:
  - You want StepFun models in OpenClaw
  - You need StepFun setup guidance
title: "StepFun"
---

# StepFun

OpenClaw includes a bundled StepFun provider plugin with two provider ids:

- `stepfun` for the standard endpoint
- `stepfun-plan` for the Step Plan endpoint

The built-in catalogs currently differ by surface:

- Standard: `step-3.5-flash`
- Step Plan: `step-3.5-flash`, `step-3.5-flash-2603`

## Region and endpoint overview

- China standard endpoint: `https://api.stepfun.com/v1`
- Global standard endpoint: `https://api.stepfun.ai/v1`
- China Step Plan endpoint: `https://api.stepfun.com/step_plan/v1`
- Global Step Plan endpoint: `https://api.stepfun.ai/step_plan/v1`
- Auth env var: `STEPFUN_API_KEY`

Use a China key with the `.com` endpoints and a global key with the `.ai`
endpoints.

## CLI setup

Interactive setup:

```bash
openclaw onboard
```

Choose one of these auth choices:

- `stepfun-standard-api-key-cn`
- `stepfun-standard-api-key-intl`
- `stepfun-plan-api-key-cn`
- `stepfun-plan-api-key-intl`

Non-interactive examples:

```bash
openclaw onboard --auth-choice stepfun-standard-api-key-intl --stepfun-api-key "$STEPFUN_API_KEY"
openclaw onboard --auth-choice stepfun-plan-api-key-intl --stepfun-api-key "$STEPFUN_API_KEY"
```

## Model refs

- Standard default model: `stepfun/step-3.5-flash`
- Step Plan default model: `stepfun-plan/step-3.5-flash`
- Step Plan alternate model: `stepfun-plan/step-3.5-flash-2603`

## Config snippets

Standard provider:

```json5
{
  env: { STEPFUN_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "stepfun/step-3.5-flash" } } },
  models: {
    mode: "merge",
    providers: {
      stepfun: {
        baseUrl: "https://api.stepfun.ai/v1",
        api: "openai-completions",
        apiKey: "${STEPFUN_API_KEY}",
        models: [
          {
            id: "step-3.5-flash",
            name: "Step 3.5 Flash",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

Step Plan provider:

```json5
{
  env: { STEPFUN_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "stepfun-plan/step-3.5-flash" } } },
  models: {
    mode: "merge",
    providers: {
      "stepfun-plan": {
        baseUrl: "https://api.stepfun.ai/step_plan/v1",
        api: "openai-completions",
        apiKey: "${STEPFUN_API_KEY}",
        models: [
          {
            id: "step-3.5-flash",
            name: "Step 3.5 Flash",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 65536,
          },
          {
            id: "step-3.5-flash-2603",
            name: "Step 3.5 Flash 2603",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

## Notes

- The provider is bundled with OpenClaw, so there is no separate plugin install step.
- `step-3.5-flash-2603` is currently exposed only on `stepfun-plan`.
- A single auth flow writes region-matched profiles for both `stepfun` and `stepfun-plan`, so both surfaces can be discovered together.
- Use `openclaw models list` and `openclaw models set <provider/model>` to inspect or switch models.
- For the broader provider overview, see [Model providers](/concepts/model-providers).
