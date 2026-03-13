---
summary: Configure Moonshot K2 vs Kimi Coding (separate providers + keys)
read_when:
  - You want Moonshot K2 (Moonshot Open Platform) vs Kimi Coding setup
  - "You need to understand separate endpoints, keys, and model refs"
  - You want copy/paste config for either provider
title: Moonshot AI
---

# Moonshot AI (Kimi)

Moonshot 提供與 OpenAI 相容的 Kimi API 端點。設定提供者並將預設模型設為 `moonshot/kimi-k2.5`，或使用 Kimi Coding 搭配 `kimi-coding/k2p5`。

目前 Kimi K2 模型 ID：

<!-- markdownlint-disable MD037 -->

{/_ moonshot-kimi-k2-ids:start _/ && null}

<!-- markdownlint-enable MD037 -->

- `kimi-k2.5`
- `kimi-k2-0905-preview`
- `kimi-k2-turbo-preview`
- `kimi-k2-thinking`
- `kimi-k2-thinking-turbo`
  <!-- markdownlint-disable MD037 -->
  {/_ moonshot-kimi-k2-ids:end _/ && null}
  <!-- markdownlint-enable MD037 -->

```bash
openclaw onboard --auth-choice moonshot-api-key
```

Kimi Coding：

```bash
openclaw onboard --auth-choice kimi-code-api-key
```

注意：Moonshot 與 Kimi Coding 是獨立的提供者。API 金鑰不可互換，端點不同，模型參考也不同（Moonshot 使用 `moonshot/...`，Kimi Coding 使用 `kimi-coding/...`）。

## 設定範例（Moonshot API）

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

## 備註

- Moonshot 模型參考使用 `moonshot/<modelId>`。Kimi Coding 模型參考使用 `kimi-coding/<modelId>`。
- 如有需要，可在 `models.providers` 中覆寫價格和上下文元資料。
- 若 Moonshot 發布不同的模型上下文限制，請相應調整 `contextWindow`。
- 國際端點使用 `https://api.moonshot.ai/v1`，中國端點使用 `https://api.moonshot.cn/v1`。

## 原生思考模式（Moonshot）

Moonshot Kimi 支援二進位原生思考：

- `thinking: { type: "enabled" }`
- `thinking: { type: "disabled" }`

可透過 `agents.defaults.models.<provider/model>.params` 依模型設定：

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

OpenClaw 也會對 Moonshot 映射執行時 `/think` 等級：

- `/think off` -> `thinking.type=disabled`
- 任何非關閉的思考等級 -> `thinking.type=enabled`

當啟用 Moonshot 思考時，`tool_choice` 必須是 `auto` 或 `none`。OpenClaw 會將不相容的 `tool_choice` 值標準化為 `auto` 以確保相容性。
