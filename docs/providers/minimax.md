---
summary: "Use MiniMax M2.1 in Clawdbot"
read_when:
  - You want MiniMax models in Clawdbot
  - You need MiniMax setup guidance
---
# MiniMax

MiniMax is an AI company that builds the **M2/M2.1** model family. The current
coding-focused release is **MiniMax M2.1** (December 23, 2025), built for
real-world complex tasks.

Source: [MiniMax M2.1 release note](https://www.minimax.io/news/minimax-m21)

## Model overview (M2.1)

MiniMax highlights these improvements in M2.1:

- Stronger **multi-language coding** (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS).
- Better **web/app development** and aesthetic output quality (including native mobile).
- Improved **composite instruction** handling for office-style workflows, building on
  interleaved thinking and integrated constraint execution.
- **More concise responses** with lower token usage and faster iteration loops.
- Stronger **tool/agent framework** compatibility and context management (Claude Code,
  Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox).
- Higher-quality **dialogue and technical writing** outputs.

## MiniMax M2.1 vs MiniMax M2.1 Lightning

- **Speed:** MiniMax docs list ~60 tps output for M2.1 and ~100 tps for Lightning.
- **Cost:** Pricing shows the same input cost, but Lightning has higher output cost.

## Choose a setup

### MiniMax M2.1 — recommended

**Best for:** hosted MiniMax with Anthropic-compatible API.

Configure via CLI:
- Run `clawdbot configure`
- Select **Model/auth**
- Choose **MiniMax M2.1**

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192
          }
        ]
      }
    }
  }
}
```

## Configure via `clawdbot configure`

Use the interactive config wizard to set MiniMax without editing JSON:

1) Run `clawdbot configure`.
2) Select **Model/auth**.
3) Choose **MiniMax M2.1**.
4) Pick your default model when prompted.

## Configuration options

- `models.providers.minimax.baseUrl`: prefer `https://api.minimax.io/anthropic` (Anthropic-compatible); `https://api.minimax.io/v1` is optional for OpenAI-compatible payloads.
- `models.providers.minimax.api`: prefer `anthropic-messages`; `openai-completions` is optional for OpenAI-compatible payloads.
- `models.providers.minimax.apiKey`: MiniMax API key (`MINIMAX_API_KEY`).
- `models.providers.minimax.models`: define `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`.
- `agents.defaults.models`: alias models you want in the allowlist.
- `models.mode`: keep `merge` if you want to add MiniMax alongside built-ins.

## Notes

- Model refs are `minimax/<model>`.
- Update pricing values in `models.json` if you need exact cost tracking.
- See [/concepts/model-providers](/concepts/model-providers) for provider rules.
- Use `clawdbot models list` and `clawdbot models set minimax/MiniMax-M2.1` to switch.
