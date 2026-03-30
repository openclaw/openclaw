---
read_when:
  - 你想了解 Moonshot K2（Moonshot Open Platform）与 Kimi Coding 的设置方式
  - 你需要理解独立的端点、密钥和模型引用
  - 你想要任一提供商的可直接复制粘贴配置
summary: 配置 Moonshot K2 与 Kimi Coding（独立提供商 + 密钥）
title: Moonshot AI
x-i18n:
  generated_at: "2026-03-16T06:26:20Z"
  model: gpt-5.4
  provider: openai
  source_hash: f95e6ffa9397e0c2bdbc247e6fb6f2892ca6a34b276ca9b773e6b875233539e3
  source_path: providers/moonshot.md
  workflow: 15
---

# Moonshot AI（Kimi）

Moonshot 提供带有 OpenAI 兼容端点的 Kimi API。配置该
提供商，并将默认模型设置为 `moonshot/kimi-k2.5`，或者使用
`kimi/kimi-code` 作为 Kimi Coding。

当前 Kimi K2 模型 ID：

[//]: # "moonshot-kimi-k2-ids:start"

- `kimi-k2.5`
- `kimi-k2-0905-preview`
- `kimi-k2-turbo-preview`
- `kimi-k2-thinking`
- `kimi-k2-thinking-turbo`

[//]: # "moonshot-kimi-k2-ids:end"

```bash
openclaw onboard --auth-choice moonshot-api-key
```

Kimi Coding：

```bash
openclaw onboard --auth-choice kimi-code-api-key
```

注意：Moonshot 和 Kimi Coding 是独立提供商。密钥不可互换，端点不同，模型引用也不同（Moonshot 使用 `moonshot/...`，Kimi Coding 使用 `kimi-coding/...`）。

## 配置片段（Moonshot API）

```json5
{
  env: { MOONSHOT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2.5" },
      models: {
        // moonshot-kimi-k2-aliases:start
        "moonshot/kimi-k2.5": { alias: "Kimi K2.5" },
        "moonshot/kimi-k2-0905-preview": { alias: "Kimi K2" },
        "moonshot/kimi-k2-turbo-preview": { alias: "Kimi K2 Turbo" },
        "moonshot/kimi-k2-thinking": { alias: "Kimi K2 Thinking" },
        "moonshot/kimi-k2-thinking-turbo": { alias: "Kimi K2 Thinking Turbo" },
        // moonshot-kimi-k2-aliases:end
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [
          // moonshot-kimi-k2-models:start
          {
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-0905-preview",
            name: "Kimi K2 0905 Preview",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-turbo-preview",
            name: "Kimi K2 Turbo",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-thinking",
            name: "Kimi K2 Thinking",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-thinking-turbo",
            name: "Kimi K2 Thinking Turbo",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          // moonshot-kimi-k2-models:end
        ],
      },
    },
  },
}
```

## Kimi Coding

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kimi/kimi-code" },
      models: {
        "kimi/kimi-code": { alias: "Kimi" },
      },
    },
  },
}
```

## 说明

- Moonshot 模型引用使用 `moonshot/<modelId>`。Kimi Coding 模型引用使用 `kimi/<modelId>`（提供商 ID 是 `kimi`，而非 `kimi-coding`）。
- 如有需要，可在 `models.providers` 中覆盖定价和上下文元数据。
- 如果 Moonshot 为某个模型发布了不同的上下文限制，请相应调整
  `contextWindow`。
- 国际端点使用 `https://api.moonshot.ai/v1`，中国端点使用 `https://api.moonshot.cn/v1`。

## 原生 thinking 模式（Moonshot）

Moonshot Kimi 支持二元原生 thinking：

- `thinking: { type: "enabled" }`
- `thinking: { type: "disabled" }`

通过 `agents.defaults.models.<provider/model>.params` 为每个模型进行配置：

```json5
{
  agents: {
    defaults: {
      models: {
        "moonshot/kimi-k2.5": {
          params: {
            thinking: { type: "disabled" },
          },
        },
      },
    },
  },
}
```

OpenClaw 还会为 Moonshot 映射运行时 `/think` 级别：

- `/think off` -> `thinking.type=disabled`
- 任何非 off 的 thinking 级别 -> `thinking.type=enabled`

当启用 Moonshot thinking 时，`tool_choice` 必须为 `auto` 或 `none`。为保持兼容性，OpenClaw 会将不兼容的 `tool_choice` 值标准化为 `auto`。
