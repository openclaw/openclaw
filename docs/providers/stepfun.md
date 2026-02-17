---
summary: "Configure StepFun Step 3.5 Flash in OpenClaw"
read_when:
  - You want StepFun / Step 3.5 Flash setup guidance
  - You need to understand API endpoints and model refs for StepFun
title: "StepFun"
---

# StepFun

[StepFun](https://platform.stepfun.ai/) is an AI company that develops the **Step** model family across language, multimodal, and reasoning capabilities.

It provides the [Step 3.5 Flash](https://github.com/stepfun-ai/Step-3.5-Flash) reasoning model API with OpenAI-compatible endpoints.

## Platform Versions

StepFun offers two platform versions depending on your region:

- **International Version**: [platform.stepfun.ai](https://platform.stepfun.ai/)
  - API Base URL: `https://api.stepfun.ai/v1`
- **China Version**: [platform.stepfun.com](https://platform.stepfun.com/)
  - API Base URL: `https://api.stepfun.com/v1`

Obtain your API key from the respective platform for your region.

## Onboarding (recommended)

To get started quickly, run the built-in onboarding command:

```bash
openclaw onboard --auth-choice stepfun-api-key
```

For non-interactive setups (e.g. CI/CD):

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice stepfun-api-key \
  --stepfun-api-key "$STEPFUN_API_KEY"
```

This command stores your credentials and configures OpenClaw with:

- Provider: `stepfun`
- Default model: `stepfun/step-3.5-flash`

## Manual configuration

Reference for `~/.openclaw/openclaw.json` (if you prefer manual editing):

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

- Default onboarding endpoint is `global` (`https://api.stepfun.ai/v1`).
- For the China endpoint, set `models.providers.stepfun.baseUrl` to `https://api.stepfun.com/v1`.
- If StepFun is already configured and you rerun onboarding with `--auth-choice stepfun-api-key`, OpenClaw keeps your existing `models.providers.stepfun.baseUrl`.
