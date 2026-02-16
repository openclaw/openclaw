---
read_when:
  - 你想了解 Moonshot K2（Moonshot 开放平台）与 Kimi Coding 的配置
  - 你需要了解独立的端点、密钥和模型引用
  - 你想获取任一提供商的可复制粘贴配置
summary: 配置 Moonshot K2 与 Kimi Coding（独立提供商和密钥）
title: Moonshot AI
x-i18n:
  generated_at: "2026-02-01T21:35:13Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 2de81b1a37a0e6e61e0e142fcd36760ecd00834e107dc9b5e38bbf971b27e18e
  source_path: providers/moonshot.md
  workflow: 15
---

# Moonshot AI (Kimi)

Moonshot 提供兼容 OpenAI 端点的 Kimi API。配置提供商并将默认模型设置为 `moonshot/kimi-k2.5`，或使用 Kimi Coding 的 `kimi-coding/k2p5`。

当前 Kimi K2 模型 ID：
{/_ moonshot-kimi-k2-ids:start _/}

- `kimi-k2.5`
- `kimi-k2-0905-preview`
- `kimi-k2-turbo-preview`
- `kimi-k2-thinking`
- `kimi-k2-thinking-turbo`
  {/_ moonshot-kimi-k2-ids:end _/}

```bash
openclaw onboard --auth-choice moonshot-api-key
```

Kimi Coding：

```bash
openclaw onboard --auth-choice kimi-code-api-key
```

注意：Moonshot 和 Kimi Coding 是独立的提供商。密钥不可互换，端点不同，模型引用也不同（Moonshot 使用 `moonshot/...`，Kimi Coding 使用 `kimi-coding/...`）。

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
      model: { primary: "kimi-coding/k2p5" },
      models: {
        "kimi-coding/k2p5": { alias: "Kimi K2.5" },
      },
    },
  },
}
```

## 注意事项

- Moonshot 模型引用使用 `moonshot/<modelId>`。Kimi Coding 模型引用使用 `kimi-coding/<modelId>`。
- 如有需要，可在 `models.providers` 中覆盖定价和上下文元数据。
- 如果 Moonshot 发布了某个模型的不同上下文限制，请相应调整 `contextWindow`。
- 如需使用中国端点，请使用 `https://api.moonshot.cn/v1`。
