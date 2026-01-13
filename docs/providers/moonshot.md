---
summary: "Use Moonshot AI (Kimi K2) with Clawdbot"
read_when:
  - You want to use Moonshot/Kimi models in Clawdbot
  - You need the Moonshot auth + config example
---
# Moonshot AI (Kimi)

Moonshot provides the Kimi API with OpenAI-compatible endpoints. Configure the
provider and set the default model to `moonshot/kimi-k2-0905-preview`.

Other current Kimi K2 model IDs:
- `kimi-k2-turbo-preview`
- `kimi-k2-thinking`
- `kimi-k2-thinking-turbo`

## CLI setup

```bash
clawdbot onboard --auth-choice moonshot-api-key
```

## Config snippet

```json5
{
  env: { MOONSHOT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2-0905-preview" },
      models: {
        "moonshot/kimi-k2-0905-preview": { alias: "Kimi K2" },
        "moonshot/kimi-k2-turbo-preview": { alias: "Kimi K2 Turbo" },
        "moonshot/kimi-k2-thinking": { alias: "Kimi K2 Thinking" },
        "moonshot/kimi-k2-thinking-turbo": { alias: "Kimi K2 Thinking Turbo" }
      }
    }
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "kimi-k2-0905-preview",
            name: "Kimi K2 0905 Preview",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192
          },
          {
            id: "kimi-k2-turbo-preview",
            name: "Kimi K2 Turbo",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192
          },
          {
            id: "kimi-k2-thinking",
            name: "Kimi K2 Thinking",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192
          },
          {
            id: "kimi-k2-thinking-turbo",
            name: "Kimi K2 Thinking Turbo",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192
          }
        ]
      }
    }
  }
}
```

## Notes

- Model refs use `moonshot/<modelId>`.
- Override pricing and context metadata in `models.providers` if needed.
- If Moonshot publishes different context limits for a model, adjust
  `contextWindow` accordingly.
- Use `https://api.moonshot.cn/v1` if you need the China endpoint.
