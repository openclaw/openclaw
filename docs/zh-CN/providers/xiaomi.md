---
read_when:
  - 你想在 OpenClaw 中使用 Xiaomi MiMo 模型
  - 你需要设置 `XIAOMI_API_KEY`
summary: 在 OpenClaw 中使用 Xiaomi MiMo 模型
title: Xiaomi MiMo
x-i18n:
  generated_at: "2026-03-20T01:18:00Z"
  model: gpt-5.4
  provider: openai
  source_hash: e0abfbe49f438807ce1c5cf5d7910e930c0d670f447f6eb53ca4e9af61cc0843
  source_path: providers/xiaomi.md
  workflow: 15
---

# Xiaomi MiMo

Xiaomi MiMo 是 **MiMo** 模型的 API 平台。OpenClaw 使用 Xiaomi 提供的
OpenAI 兼容端点，并通过 API key 认证。请在
[Xiaomi MiMo console](https://platform.xiaomimimo.com/#/console/api-keys) 中创建你的 API key，然后用它配置内置的
`xiaomi` 提供商。

## 模型概览

- **mimo-v2-flash**：默认文本模型，262144-token 上下文窗口
- **mimo-v2-pro**：支持推理的文本模型，1048576-token 上下文窗口
- **mimo-v2-omni**：支持推理的多模态模型，支持文本和图像输入，262144-token 上下文窗口
- Base URL：`https://api.xiaomimimo.com/v1`
- API：`openai-completions`
- 认证方式：`Bearer $XIAOMI_API_KEY`

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
        baseUrl: "https://api.xiaomimimo.com/v1",
        api: "openai-completions",
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

## 说明

- 默认模型引用：`xiaomi/mimo-v2-flash`。
- 额外内置模型：`xiaomi/mimo-v2-pro`、`xiaomi/mimo-v2-omni`。
- 当设置了 `XIAOMI_API_KEY`（或存在凭证配置文件）时，提供商会自动注入。
- 有关提供商规则，请参阅 [/concepts/model-providers](/concepts/model-providers)。
