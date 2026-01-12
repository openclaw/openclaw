---
summary: "Use MiniMax M2.1 in Clawdbot (cloud, API, or LM Studio)"
read_when:
  - You want MiniMax models in Clawdbot
  - You need MiniMax cloud/API setup or LM Studio config
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

## Choose a setup

### Option A: MiniMax Cloud (OpenAI-compatible `/v1`)

**Best for:** hosted MiniMax with OpenAI-compatible API.

```bash
clawdbot onboard --auth-choice minimax-cloud
# or non-interactive
clawdbot onboard --auth-choice minimax-cloud --minimax-api-key "$MINIMAX_API_KEY"
```

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/v1",
        apiKey: "${MINIMAX_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192
          }
        ]
      }
    }
  }
}
```

### Option B: MiniMax API (Anthropic-compatible `/anthropic`)

**Best for:** MiniMax's Anthropic-compatible API (platform.minimax.io).

```bash
clawdbot onboard --auth-choice minimax-api
# or non-interactive
clawdbot onboard --auth-choice minimax-api --minimax-api-key "$MINIMAX_API_KEY"
```

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
          },
          {
            id: "MiniMax-M2.1-lightning",
            name: "MiniMax M2.1 Lightning",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192
          },
          {
            id: "MiniMax-M2",
            name: "MiniMax M2",
            reasoning: true,
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

### Option C: Local via LM Studio

**Best for:** local inference with LM Studio.
We have seen strong results with MiniMax M2.1 on powerful hardware (e.g. a
beefy Mac Studio) using LM Studio's local server.

```bash
clawdbot onboard --auth-choice minimax
```

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } }
    }
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
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
3) Choose **MiniMax M2.1 (minimax.io)**, **MiniMax API (platform.minimax.io)**,
   or **MiniMax M2.1 (LM Studio)**.
4) Pick your default model when prompted.

## Configuration options

- `models.providers.minimax.baseUrl`: `https://api.minimax.io/v1` or `https://api.minimax.io/anthropic`.
- `models.providers.minimax.api`: `openai-completions` (cloud) or `anthropic-messages` (API).
- `models.providers.minimax.apiKey`: MiniMax API key (`MINIMAX_API_KEY`).
- `models.providers.minimax.models`: define `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`.
- `agents.defaults.models`: alias models you want in the allowlist.
- `models.mode`: keep `merge` if you want to add MiniMax alongside built-ins.

## Notes

- Model refs are `minimax/<model>` or `lmstudio/<model>`.
- MiniMax pricing is not published; the costs above are placeholders.
  Override in `models.json` for accurate tracking.
- See [/concepts/model-providers](/concepts/model-providers) for provider rules.
- Use `clawdbot models list` and `clawdbot models set minimax/MiniMax-M2.1` to switch.
