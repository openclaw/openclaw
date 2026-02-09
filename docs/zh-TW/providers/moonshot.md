---
summary: "設定 Moonshot K2 與 Kimi Coding（獨立的提供者與金鑰）"
read_when:
  - 你想要設定 Moonshot K2（Moonshot Open Platform）與 Kimi Coding
  - You need to understand separate endpoints, keys, and model refs
  - 你想要可直接複製貼上的設定，適用於任一提供者
title: "Moonshot AI"
---

# Moonshot AI（Kimi）

Moonshot 提供具有 OpenAI 相容端點的 Kimi API。請設定
提供者，並將預設模型設為 `moonshot/kimi-k2.5`，或使用
Kimi Coding 搭配 `kimi-coding/k2p5`。 Configure the
provider and set the default model to `moonshot/kimi-k2.5`, or use
Kimi Coding with `kimi-coding/k2p5`.

目前的 Kimi K2 模型 ID：

{/_moonshot-kimi-k2-ids:start_/ && null}

- `kimi-k2.5`
- `kimi-k2-0905-preview`
- `kimi-k2-turbo-preview`
- `kimi-k2-thinking`
- `kimi-k2-thinking-turbo`
  {/_moonshot-kimi-k2-ids:end_/ && null}

```bash
openclaw onboard --auth-choice moonshot-api-key
```

Kimi Coding：

```bash
openclaw onboard --auth-choice kimi-code-api-key
```

Note: Moonshot and Kimi Coding are separate providers. 注意：Moonshot 與 Kimi Coding 是不同的提供者。金鑰不可互換，端點不同，且模型參照也不同（Moonshot 使用 `moonshot/...`，Kimi Coding 使用 `kimi-coding/...`）。

## 設定片段（Moonshot API）

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

## 注意事項

- Moonshot 的模型參照使用 `moonshot/<modelId>`。Kimi Coding 的模型參照使用 `kimi-coding/<modelId>`。 Kimi Coding model refs use `kimi-coding/<modelId>`.
- 如有需要，可在 `models.providers` 中覆寫定價與上下文中繼資料。
- 若 Moonshot 為某個模型公布不同的上下文限制，請相應調整
  `contextWindow`。
- 國際端點請使用 `https://api.moonshot.ai/v1`，中國端點請使用 `https://api.moonshot.cn/v1`。
