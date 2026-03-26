---
summary: "Use Xiaomi MiMo models with OpenClaw"
read_when:
  - You want Xiaomi MiMo models in OpenClaw
  - You need MIMO_API_KEY or XIAOMI_API_KEY setup
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

Xiaomi MiMo is the API platform for **MiMo** models. OpenClaw uses the Xiaomi
OpenAI-compatible endpoint with API-key authentication. Create your API key in the
[Xiaomi MiMo console](https://platform.xiaomimimo.com/#/console/api-keys), then configure the
bundled `xiaomi` provider with that key.

## Model overview

- **mimo-v2-flash**: default text model, 262144-token context window
- **mimo-v2-pro**: reasoning text model, 1048576-token context window
- **mimo-v2-omni**: reasoning multimodal model with text and image input, 262144-token context window
- Base URL: `https://api.xiaomimimo.com/v1`
- API: `openai-completions`
- Authorization: `Bearer $MIMO_API_KEY` or `Bearer $XIAOMI_API_KEY` (either env var is accepted)

## CLI setup

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$MIMO_API_KEY"
# or: export XIAOMI_API_KEY=... (also detected)
```

## Config snippet

```json5
{
  env: { MIMO_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "xiaomi/mimo-v2-flash" } } },
  models: {
    mode: "merge",
    providers: {
      xiaomi: {
        baseUrl: "https://api.xiaomimimo.com/v1",
        api: "openai-completions",
        apiKey: "${MIMO_API_KEY}",
        models: [
          {
            id: "mimo-v2-flash",
            name: "Xiaomi MiMo V2 Flash",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 8192,
          },
          {
            id: "mimo-v2-pro",
            name: "Xiaomi MiMo V2 Pro",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1048576,
            maxTokens: 32000,
          },
          {
            id: "mimo-v2-omni",
            name: "Xiaomi MiMo V2 Omni",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 32000,
          },
        ],
      },
    },
  },
}
```

## Notes

- Default model ref: `xiaomi/mimo-v2-flash`.
- Additional built-in models: `xiaomi/mimo-v2-pro`, `xiaomi/mimo-v2-omni`.
- The provider is injected automatically when `MIMO_API_KEY` or `XIAOMI_API_KEY` is set (or an auth profile exists).
- You can use `env: { XIAOMI_API_KEY: "..." }` and `apiKey: "${XIAOMI_API_KEY}"` instead; both env names are equivalent for auth resolution.
- See [/concepts/model-providers](/concepts/model-providers) for provider rules.
