---
summary: Use Xiaomi MiMo (mimo-v2-flash) with OpenClaw
read_when:
  - You want Xiaomi MiMo models in OpenClaw
  - You need XIAOMI_API_KEY setup
title: Xiaomi MiMo
---

# 小米 MiMo

小米 MiMo 是用於 **MiMo** 模型的 API 平台。它提供與 OpenAI 和 Anthropic 格式相容的 REST API，並使用 API 金鑰進行身份驗證。請在 [小米 MiMo 控制台](https://platform.xiaomimimo.com/#/console/api-keys) 創建您的 API 金鑰。OpenClaw 使用帶有小米 MiMo API 金鑰的 `xiaomi` 提供者。

## 模型概覽

- **mimo-v2-flash**：262144 token上下文視窗，兼容 Anthropic Messages API。
- 基本 URL：`https://api.xiaomimimo.com/anthropic`
- 授權方式：`Bearer $XIAOMI_API_KEY`

## CLI 設定

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## 設定範例

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
- 當設定 `XIAOMI_API_KEY`（或存在授權設定檔）時，提供者會自動注入。
- 請參考 [/concepts/model-providers](/concepts/model-providers) 了解提供者規則。
