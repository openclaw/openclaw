---
summary: "將 Xiaomi MiMo (mimo-v2-flash) 與 OpenClaw 搭配使用"
read_when:
  - 您希望在 OpenClaw 中使用 Xiaomi MiMo 模型
  - 您需要設定 XIAOMI_API_KEY
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

Xiaomi MiMo 是 **MiMo** 模型的 API 平台。它提供與 OpenAI 和 Anthropic 格式相容的 REST API，並使用 API 金鑰進行身份驗證。請在 [Xiaomi MiMo console](https://platform.xiaomimimo.com/#/console/api-keys) 中建立您的 API 金鑰。OpenClaw 透過 Xiaomi MiMo API 金鑰使用 `xiaomi` 供應商。

## 模型概覽

- **mimo-v2-flash**：262144 token 的上下文視窗，相容於 Anthropic Messages API。
- 基礎 URL：`https://api.xiaomimimo.com/anthropic`
- 授權：`Bearer $XIAOMI_API_KEY`

## CLI 設定

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## 設定程式碼片段

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

## 備註

- 模型參考：`xiaomi/mimo-v2-flash`。
- 當設定 `XIAOMI_API_KEY`（或存在身份驗證設定檔）時，供應商將自動注入。
- 有關供應商規則，請參閱 [/concepts/model-providers](/concepts/model-providers)。
