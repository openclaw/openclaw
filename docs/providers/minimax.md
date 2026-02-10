---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Use MiniMax M2.1 in OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want MiniMax models in OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need MiniMax setup guidance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "MiniMax"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# MiniMax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
MiniMax is an AI company that builds the **M2/M2.1** model family. The current（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
coding-focused release is **MiniMax M2.1** (December 23, 2025), built for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
real-world complex tasks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Source: [MiniMax M2.1 release note](https://www.minimax.io/news/minimax-m21)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Model overview (M2.1)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
MiniMax highlights these improvements in M2.1:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Stronger **multi-language coding** (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Better **web/app development** and aesthetic output quality (including native mobile).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Improved **composite instruction** handling for office-style workflows, building on（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  interleaved thinking and integrated constraint execution.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **More concise responses** with lower token usage and faster iteration loops.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Stronger **tool/agent framework** compatibility and context management (Claude Code,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Higher-quality **dialogue and technical writing** outputs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## MiniMax M2.1 vs MiniMax M2.1 Lightning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Speed:** Lightning is the “fast” variant in MiniMax’s pricing docs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Cost:** Pricing shows the same input cost, but Lightning has higher output cost.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Coding plan routing:** The Lightning back-end isn’t directly available on the MiniMax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  coding plan. MiniMax auto-routes most requests to Lightning, but falls back to the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  regular M2.1 back-end during traffic spikes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Choose a setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### MiniMax OAuth (Coding Plan) — recommended（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Best for:** quick setup with MiniMax Coding Plan via OAuth, no API key required.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enable the bundled OAuth plugin and authenticate:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins enable minimax-portal-auth  # skip if already loaded.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway restart  # restart if gateway is already running（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --auth-choice minimax-portal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You will be prompted to select an endpoint:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Global** - International users (`api.minimax.io`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **CN** - Users in China (`api.minimaxi.com`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [MiniMax OAuth plugin README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth) for details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### MiniMax M2.1 (API key)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Best for:** hosted MiniMax with Anthropic-compatible API.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Configure via CLI:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run `openclaw configure`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Select **Model/auth**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Choose **MiniMax M2.1**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: { MINIMAX_API_KEY: "sk-..." },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mode: "merge",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    providers: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      minimax: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        baseUrl: "https://api.minimax.io/anthropic",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "${MINIMAX_API_KEY}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        api: "anthropic-messages",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            id: "MiniMax-M2.1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            name: "MiniMax M2.1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            reasoning: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            input: ["text"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            contextWindow: 200000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            maxTokens: 8192,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### MiniMax M2.1 as fallback (Opus primary)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Best for:** keep Opus 4.6 as primary, fail over to MiniMax M2.1.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: { MINIMAX_API_KEY: "sk-..." },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "anthropic/claude-opus-4-6": { alias: "opus" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "minimax/MiniMax-M2.1": { alias: "minimax" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        primary: "anthropic/claude-opus-4-6",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        fallbacks: ["minimax/MiniMax-M2.1"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Optional: Local via LM Studio (manual)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Best for:** local inference with LM Studio.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
We have seen strong results with MiniMax M2.1 on powerful hardware (e.g. a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
desktop/server) using LM Studio's local server.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Configure manually via `openclaw.json`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: { primary: "lmstudio/minimax-m2.1-gs32" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mode: "merge",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    providers: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      lmstudio: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        baseUrl: "http://127.0.0.1:1234/v1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "lmstudio",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        api: "openai-responses",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            id: "minimax-m2.1-gs32",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            name: "MiniMax M2.1 GS32",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            reasoning: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            input: ["text"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            contextWindow: 196608,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            maxTokens: 8192,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configure via `openclaw configure`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the interactive config wizard to set MiniMax without editing JSON:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Run `openclaw configure`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Select **Model/auth**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Choose **MiniMax M2.1**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Pick your default model when prompted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `models.providers.minimax.baseUrl`: prefer `https://api.minimax.io/anthropic` (Anthropic-compatible); `https://api.minimax.io/v1` is optional for OpenAI-compatible payloads.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `models.providers.minimax.api`: prefer `anthropic-messages`; `openai-completions` is optional for OpenAI-compatible payloads.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `models.providers.minimax.apiKey`: MiniMax API key (`MINIMAX_API_KEY`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `models.providers.minimax.models`: define `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.models`: alias models you want in the allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `models.mode`: keep `merge` if you want to add MiniMax alongside built-ins.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model refs are `minimax/<model>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Coding Plan usage API: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (requires a coding plan key).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Update pricing values in `models.json` if you need exact cost tracking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Referral link for MiniMax Coding Plan (10% off): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- See [/concepts/model-providers](/concepts/model-providers) for provider rules.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `openclaw models list` and `openclaw models set minimax/MiniMax-M2.1` to switch.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### “Unknown model: minimax/MiniMax-M2.1”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This usually means the **MiniMax provider isn’t configured** (no provider entry（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
and no MiniMax auth profile/env key found). A fix for this detection is in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**2026.1.12** (unreleased at the time of writing). Fix by:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Upgrading to **2026.1.12** (or run from source `main`), then restarting the gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Running `openclaw configure` and selecting **MiniMax M2.1**, or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Adding the `models.providers.minimax` block manually, or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Setting `MINIMAX_API_KEY` (or a MiniMax auth profile) so the provider can be injected.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Make sure the model id is **case‑sensitive**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `minimax/MiniMax-M2.1`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `minimax/MiniMax-M2.1-lightning`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then recheck with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
