---
summary: "Configure StepFun Step 3.5 Flash in OpenClaw"
read_when:
  - You want StepFun / Step 3.5 Flash setup guidance
  - You need to understand API endpoints and model refs for StepFun
title: "StepFun"
---

# StepFun

StepFun is an AI company that builds the **Step** model series, covering text, audio, and multi-modal models. It provides the [Step 3.5 Flash](https://github.com/stepfun-ai/Step-3.5-Flash) reasoning model API with OpenAI-compatible endpoints. Get your API key from the StepFun Open Platform.

## Onboarding (recommended)

Use the built-in onboarding flow:

```bash
openclaw onboard --auth-choice stepfun-api-key
```

Non-interactive:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice stepfun-api-key \
  --stepfun-api-key "$STEPFUN_API_KEY"
```

This stores auth in the agent auth profile store and configures:

- Provider: `stepfun`
- Default model: `stepfun/step-3.5-flash`

## Manual configuration (fallback)

Configure StepFun by editing `~/.openclaw/openclaw.json` directly.

```json5
{
  models: {
    providers: {
      stepfun: {
        baseUrl: "https://api.stepfun.ai/v1",
        apiKey: "YOUR_SK_KEY_HERE",
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

- Use `https://api.stepfun.ai/v1` for the international endpoint, and `https://api.stepfun.com/v1` for the China endpoint.
- Onboarding uses `https://api.stepfun.ai/v1` by default.
- For China endpoint users, set `models.providers.stepfun.baseUrl` to `https://api.stepfun.com/v1` in config or Control UI.
