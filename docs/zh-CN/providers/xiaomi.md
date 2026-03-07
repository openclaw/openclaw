---
read_when:
  - 你想在 OpenClaw 中使用 Xiaomi MiMo 模型
  - 你需要设置 XIAOMI_API_KEY
summary: 在 OpenClaw 中使用 Xiaomi MiMo (mimo-v2-flash)
title: Xiaomi MiMo
x-i18n:
  generated_at: "2026-02-01T21:36:15Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 366fd2297b2caf8c5ad944d7f1b6d233b248fe43aedd22a28352ae7f370d2435
  source_path: providers/xiaomi.md
  workflow: 15
---

# Xiaomi MiMo

Xiaomi MiMo 是 **MiMo** 模型的 API 平台。它提供与 OpenAI 和 Anthropic 格式兼容的 REST API，并使用 API 密钥进行身份验证。请在 [Xiaomi MiMo 控制台](https://platform.xiaomimimo.com/#/console/api-keys) 中创建你的 API 密钥。OpenClaw 使用 `xiaomi` 提供商配合 Xiaomi MiMo API 密钥。

## 模型概览

- **mimo-v2-flash**：262144 token 上下文窗口，兼容 Anthropic Messages API。
- 基础 URL：`https://api.xiaomimimo.com/anthropic`
- 授权方式：`Bearer $XIAOMI_API_KEY`

## CLI 设置

```bash
openclaw onboard --auth-choice xiaomi-api-key
# 或非交互式
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## 配置片段

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

## 备注

- 模型引用：`xiaomi/mimo-v2-flash`。
- 当设置了 `XIAOMI_API_KEY`（或存在身份验证配置文件）时，该提供商会自动注入。
- 有关提供商规则，请参阅 [/concepts/model-providers](/concepts/model-providers)。
