---
summary: "Use Upstage Solar models with OpenClaw"
read_when:
  - You want Upstage Solar models in OpenClaw
  - You need UPSTAGE_API_KEY setup
title: "Upstage Solar"
---

# Upstage Solar

Upstage Solar is the API platform for **Solar** models. It provides OpenAI-compatible
REST APIs and uses API keys for authentication. Create your API key in the
[Upstage console](https://console.upstage.ai). OpenClaw uses the `upstage` provider
with an Upstage API key.

## Model overview

- **solar-pro3-260126**: 102B MoE (12B active), 128K context, reasoning + function calling
- **solar-pro2-251215**: 31B, 65K context, reasoning + function calling
- Base URL: `https://api.upstage.ai/v1/solar`
- Authorization: `Bearer $UPSTAGE_API_KEY`

## CLI setup

```bash
openclaw onboard --auth-choice upstage-api-key
# or non-interactive
openclaw onboard --auth-choice upstage-api-key --upstage-api-key "$UPSTAGE_API_KEY"
```

## Config snippet

```json5
{
  env: { UPSTAGE_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "upstage/solar-pro3-260126" } } },
  models: {
    mode: "merge",
    providers: {
      upstage: {
        baseUrl: "https://api.upstage.ai/v1/solar",
        api: "openai-completions",
        apiKey: "UPSTAGE_API_KEY",
        models: [
          {
            id: "solar-pro3-260126",
            name: "Solar Pro3",
            reasoning: true,
            input: ["text"],
            cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
          {
            id: "solar-pro2-251215",
            name: "Solar Pro2",
            reasoning: true,
            input: ["text"],
            cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
            contextWindow: 65000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Notes

- Model ref: `upstage/solar-pro3-260126`.
- The provider is injected automatically when `UPSTAGE_API_KEY` is set (or an auth profile exists).
- Pricing: $0.15/1M input tokens, $0.015/1M cached input, $0.60/1M output tokens.
- See [/concepts/model-providers](/concepts/model-providers) for provider rules.
