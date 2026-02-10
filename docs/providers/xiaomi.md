---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Use Xiaomi MiMo (mimo-v2-flash) with OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want Xiaomi MiMo models in OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need XIAOMI_API_KEY setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Xiaomi MiMo"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Xiaomi MiMo（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Xiaomi MiMo is the API platform for **MiMo** models. It provides REST APIs compatible with（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenAI and Anthropic formats and uses API keys for authentication. Create your API key in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the [Xiaomi MiMo console](https://platform.xiaomimimo.com/#/console/api-keys). OpenClaw uses（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the `xiaomi` provider with a Xiaomi MiMo API key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Model overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **mimo-v2-flash**: 262144-token context window, Anthropic Messages API compatible.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Base URL: `https://api.xiaomimimo.com/anthropic`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Authorization: `Bearer $XIAOMI_API_KEY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --auth-choice xiaomi-api-key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# or non-interactive（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config snippet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: { XIAOMI_API_KEY: "your-key" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { model: { primary: "xiaomi/mimo-v2-flash" } } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mode: "merge",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    providers: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      xiaomi: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        baseUrl: "https://api.xiaomimimo.com/anthropic",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        api: "anthropic-messages",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "XIAOMI_API_KEY",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            id: "mimo-v2-flash",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            name: "Xiaomi MiMo V2 Flash",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            reasoning: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            input: ["text"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            contextWindow: 262144,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            maxTokens: 8192,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model ref: `xiaomi/mimo-v2-flash`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The provider is injected automatically when `XIAOMI_API_KEY` is set (or an auth profile exists).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- See [/concepts/model-providers](/concepts/model-providers) for provider rules.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
