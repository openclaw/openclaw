---
summary: "Use DeepSeek V4 (deepseek-v4-pro / deepseek-v4-flash) with Moltbot"
read_when:
  - You want DeepSeek V4 models in Moltbot
  - You need DEEPSEEK_API_KEY setup
---
# DeepSeek

DeepSeek is the API platform for the **DeepSeek V4** model family. It is OpenAI-compatible and
also exposes an Anthropic Messages-compatible endpoint, and authenticates with an API key.
Create your API key in the [DeepSeek console](https://platform.deepseek.com/api_keys). Moltbot
uses the `deepseek` provider with a DeepSeek API key.

## Model overview

- **deepseek-v4-pro**: 1,000,000-token context window, reasoning enabled, top-tier intelligence.
- **deepseek-v4-flash**: 1,000,000-token context window, reasoning enabled, fast/economical.
- Base URL: `https://api.deepseek.com/anthropic`
- Authorization: `Bearer $DEEPSEEK_API_KEY`

## CLI setup

```bash
moltbot onboard --auth-choice deepseek-api-key
# or non-interactive
moltbot onboard --auth-choice deepseek-api-key --deepseek-api-key "$DEEPSEEK_API_KEY"
```

## Config snippet

```json5
{
  env: { DEEPSEEK_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "deepseek/deepseek-v4-pro" } } },
  models: {
    mode: "merge",
    providers: {
      deepseek: {
        baseUrl: "https://api.deepseek.com/anthropic",
        api: "anthropic-messages",
        apiKey: "DEEPSEEK_API_KEY",
        models: [
          {
            id: "deepseek-v4-pro",
            name: "DeepSeek V4 Pro",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000000,
            maxTokens: 8192
          },
          {
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000000,
            maxTokens: 8192
          }
        ]
      }
    }
  }
}
```

## Notes

- Default model ref: `deepseek/deepseek-v4-pro`. Switch to `deepseek/deepseek-v4-flash` for cheaper/faster runs.
- The provider is injected automatically when `DEEPSEEK_API_KEY` is set (or an auth profile exists).
- Override `cost` in `models.json` to track real spend (DeepSeek pricing varies; not seeded here).
- Legacy `deepseek-chat` and `deepseek-reasoner` model IDs are routed to `deepseek-v4-flash` by DeepSeek and will be retired on 2026-07-24 — migrate to the V4 IDs.
- See [/concepts/model-providers](/concepts/model-providers) for provider rules.
