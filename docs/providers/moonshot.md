---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Configure Moonshot K2 vs Kimi Coding (separate providers + keys)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want Moonshot K2 (Moonshot Open Platform) vs Kimi Coding setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need to understand separate endpoints, keys, and model refs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want copy/paste config for either provider（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Moonshot AI"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Moonshot AI (Kimi)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Moonshot provides the Kimi API with OpenAI-compatible endpoints. Configure the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
provider and set the default model to `moonshot/kimi-k2.5`, or use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Kimi Coding with `kimi-coding/k2p5`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Current Kimi K2 model IDs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{/_moonshot-kimi-k2-ids:start_/ && null}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `kimi-k2.5`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `kimi-k2-0905-preview`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `kimi-k2-turbo-preview`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `kimi-k2-thinking`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `kimi-k2-thinking-turbo`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {/_moonshot-kimi-k2-ids:end_/ && null}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --auth-choice moonshot-api-key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Kimi Coding:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --auth-choice kimi-code-api-key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: Moonshot and Kimi Coding are separate providers. Keys are not interchangeable, endpoints differ, and model refs differ (Moonshot uses `moonshot/...`, Kimi Coding uses `kimi-coding/...`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config snippet (Moonshot API)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: { MOONSHOT_API_KEY: "sk-..." },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: { primary: "moonshot/kimi-k2.5" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        // moonshot-kimi-k2-aliases:start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "moonshot/kimi-k2.5": { alias: "Kimi K2.5" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "moonshot/kimi-k2-0905-preview": { alias: "Kimi K2" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "moonshot/kimi-k2-turbo-preview": { alias: "Kimi K2 Turbo" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "moonshot/kimi-k2-thinking": { alias: "Kimi K2 Thinking" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "moonshot/kimi-k2-thinking-turbo": { alias: "Kimi K2 Thinking Turbo" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        // moonshot-kimi-k2-aliases:end（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mode: "merge",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    providers: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      moonshot: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        baseUrl: "https://api.moonshot.ai/v1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "${MOONSHOT_API_KEY}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        api: "openai-completions",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          // moonshot-kimi-k2-models:start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            id: "kimi-k2.5",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            name: "Kimi K2.5",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            reasoning: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            input: ["text"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            contextWindow: 256000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            maxTokens: 8192,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            id: "kimi-k2-0905-preview",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            name: "Kimi K2 0905 Preview",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            reasoning: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            input: ["text"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            contextWindow: 256000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            maxTokens: 8192,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            id: "kimi-k2-turbo-preview",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            name: "Kimi K2 Turbo",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            reasoning: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            input: ["text"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            contextWindow: 256000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            maxTokens: 8192,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            id: "kimi-k2-thinking",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            name: "Kimi K2 Thinking",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            reasoning: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            input: ["text"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            contextWindow: 256000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            maxTokens: 8192,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            id: "kimi-k2-thinking-turbo",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            name: "Kimi K2 Thinking Turbo",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            reasoning: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            input: ["text"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            contextWindow: 256000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            maxTokens: 8192,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          // moonshot-kimi-k2-models:end（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Kimi Coding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: { KIMI_API_KEY: "sk-..." },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: { primary: "kimi-coding/k2p5" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "kimi-coding/k2p5": { alias: "Kimi K2.5" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Moonshot model refs use `moonshot/<modelId>`. Kimi Coding model refs use `kimi-coding/<modelId>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Override pricing and context metadata in `models.providers` if needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If Moonshot publishes different context limits for a model, adjust（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `contextWindow` accordingly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `https://api.moonshot.ai/v1` for the international endpoint, and `https://api.moonshot.cn/v1` for the China endpoint.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
