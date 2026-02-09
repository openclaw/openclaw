---
summary: "在 OpenClaw 中使用 Xiaomi MiMo（mimo-v2-flash）"
read_when:
  - 你想在 OpenClaw 中使用 Xiaomi MiMo 模型
  - 你需要設定 XIAOMI_API_KEY
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

Xiaomi MiMo 是 **MiMo** 模型的 API 平台。 它提供與 OpenAI 和 Anthropic 格式相容的 REST API，並使用 API 金鑰進行驗證。 Xiaomi MiMo 是 **MiMo** 模型的 API 平台。它提供與 OpenAI 與 Anthropic 格式相容的 REST API，並使用 API 金鑰進行身分驗證。請在 [Xiaomi MiMo 主控台](https://platform.xiaomimimo.com/#/console/api-keys) 建立你的 API 金鑰。OpenClaw 會使用 `xiaomi` 提供者搭配 Xiaomi MiMo API 金鑰。 OpenClaw uses
the `xiaomi` provider with a Xiaomi MiMo API key.

## 模型概覽

- **mimo-v2-flash**：262144-token 的上下文視窗，與 Anthropic Messages API 相容。
- Base URL：`https://api.xiaomimimo.com/anthropic`
- Authorization：`Bearer $XIAOMI_API_KEY`

## CLI 設定

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## 設定片段

```json5
{
  env: { XIAOMI_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "xiaomi/mimo-v2-flash" } } },
  models: {
    mode: "merge",
    providers: {
      xiaomi: {
        baseUrl: "https://api.xiaomimimo.com/anthropic",
        api: "anthropic-messages",
        apiKey: "XIAOMI_API_KEY",
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
        ],
      },
    },
  },
}
```

## 注意事項

- 模型參考：`xiaomi/mimo-v2-flash`。
- 當設定 `XIAOMI_API_KEY`（或存在身分驗證設定檔）時，提供者會自動注入。
- 請參閱 [/concepts/model-providers](/concepts/model-providers) 以了解提供者規則。
