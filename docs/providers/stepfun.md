---
summary: "Configure StepFun Step 3.5 Flash in OpenClaw"
read_when:
  - You want StepFun / Step 3.5 Flash setup guidance
  - You need to understand API endpoints and model refs for StepFun
title: "StepFun"
---

# StepFun

[StepFun](https://platform.stepfun.ai/) provides the **Step** model family, including the
reasoning-capable **Step 3.5 Flash** model via OpenAI-compatible endpoints.

## Platform Versions

StepFun offers different platforms by region:

- International: [platform.stepfun.ai](https://platform.stepfun.ai/)
  - API base URL: `https://api.stepfun.ai/v1`
- China: [platform.stepfun.com](https://platform.stepfun.com/)
  - API base URL: `https://api.stepfun.com/v1`

Use an API key from the platform for your region.

## Onboarding (recommended)

Global endpoint:

```bash
openclaw onboard --auth-choice stepfun-api-key
```

China endpoint:

```bash
openclaw onboard --auth-choice stepfun-cn
```

For non-interactive setups (e.g. CI/CD):

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice stepfun-api-key \
  --stepfun-api-key "$STEPFUN_API_KEY"
```

For the China endpoint in non-interactive mode:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice stepfun-cn \
  --stepfun-api-key "$STEPFUN_API_KEY"
```

This stores StepFun credentials and configures OpenClaw with:

- Provider: `stepfun`
- Default model: `stepfun/step-3.5-flash`

## Manual Configuration

Reference `~/.openclaw/openclaw.json` (if you prefer manual editing):

```json5
{
  models: {
    providers: {
      stepfun: {
        // Global default. For China endpoint use: "https://api.stepfun.com/v1"
        baseUrl: "https://api.stepfun.ai/v1",
        apiKey: "YOUR_API_KEY",
        auth: "api-key",
        api: "openai-completions",
        models: [
          {
            id: "step-3.5-flash",
            name: "Step 3.5 Flash",
            contextWindow: 256000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: {
        primary: "stepfun/step-3.5-flash",
      },
    },
  },
}
```

## Notes

- `stepfun-api-key` uses the global endpoint (`https://api.stepfun.ai/v1`).
- `stepfun-cn` uses the China endpoint (`https://api.stepfun.com/v1`).
- If StepFun is already configured and you rerun onboarding with `stepfun-api-key`, OpenClaw keeps the existing `models.providers.stepfun.baseUrl`.
