---
summary: "Use MiniMax M2.5 in OpenClaw"
read_when:
  - You want MiniMax models in OpenClaw
  - You need MiniMax setup guidance
title: "MiniMax"
---

# MiniMax

MiniMax is an AI company that builds the **M2/M2.5** model family. The current
coding-focused release is **MiniMax M2.5** (December 23, 2025), built for
real-world complex tasks.

Source: [MiniMax M2.5 release note](https://www.minimax.io/news/minimax-m25)

## Model overview (M2.5)

MiniMax highlights these improvements in M2.5:

- Stronger **multi-language coding** (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS).
- Better **web/app development** and aesthetic output quality (including native mobile).
- Improved **composite instruction** handling for office-style workflows, building on
  interleaved thinking and integrated constraint execution.
- **More concise responses** with lower token usage and faster iteration loops.
- Stronger **tool/agent framework** compatibility and context management (Claude Code,
  Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox).
- Higher-quality **dialogue and technical writing** outputs.

## MiniMax M2.5 vs MiniMax M2.5 Highspeed

- **Speed:** `MiniMax-M2.5-highspeed` is the official fast tier in MiniMax docs.
- **Cost:** MiniMax pricing lists the same input cost and a higher output cost for highspeed.
- **Current model IDs:** use `MiniMax-M2.5` or `MiniMax-M2.5-highspeed`.

## Choose a setup

### MiniMax OAuth (Coding Plan) — recommended

**Best for:** quick setup with MiniMax Coding Plan via OAuth, no API key required.

Enable the bundled OAuth plugin and authenticate:

```bash
openclaw plugins enable minimax  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

You will be prompted to select an endpoint:

- **Global** - International users (`api.minimax.io`)
- **CN** - Users in China (`api.minimaxi.com`)

See [MiniMax plugin README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax) for details.

### MiniMax M2.5 (API key)

**Best for:** hosted MiniMax with Anthropic-compatible API.

Configure via CLI:

- Run `openclaw configure`
- Select **Model/auth**
- Choose **MiniMax M2.5**

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.5" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.5",
            name: "MiniMax M2.5",
            reasoning: true,
            input: ["text"],
            cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.12 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
          {
            id: "MiniMax-M2.5-highspeed",
            name: "MiniMax M2.5 Highspeed",
            reasoning: true,
            input: ["text"],
            cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.12 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.5 as fallback (example)

**Best for:** keep your strongest latest-generation model as primary, fail over to MiniMax M2.5.
Example below uses Opus as a concrete primary; swap to your preferred latest-gen primary model.

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "primary" },
        "minimax/MiniMax-M2.5": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.5"],
      },
    },
  },
}
```

### Optional: Local via LM Studio (manual)

**Best for:** local inference with LM Studio.
We have seen strong results with MiniMax M2.5 on powerful hardware (e.g. a
desktop/server) using LM Studio's local server.

Configure manually via `openclaw.json`:

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.5-gs32" },
      models: { "lmstudio/minimax-m2.5-gs32": { alias: "Minimax" } },
    },
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
            id: "minimax-m2.5-gs32",
            name: "MiniMax M2.5 GS32",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Configure via `openclaw configure`

Use the interactive config wizard to set MiniMax without editing JSON:

1. Run `openclaw configure`.
2. Select **Model/auth**.
3. Choose **MiniMax M2.5**.
4. Pick your default model when prompted.

## Configuration options

- `models.providers.minimax.baseUrl`: prefer `https://api.minimax.io/anthropic` (Anthropic-compatible); `https://api.minimax.io/v1` is optional for OpenAI-compatible payloads.
- `models.providers.minimax.api`: prefer `anthropic-messages`; `openai-completions` is optional for OpenAI-compatible payloads.
- `models.providers.minimax.apiKey`: MiniMax API key (`MINIMAX_API_KEY`).
- `models.providers.minimax.models`: define `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`.
- `agents.defaults.models`: alias models you want in the allowlist.
- `models.mode`: keep `merge` if you want to add MiniMax alongside built-ins.

## Notes

- Model refs are `minimax/<model>`.
- Recommended model IDs: `MiniMax-M2.5` and `MiniMax-M2.5-highspeed`.
- Coding Plan usage API: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (requires a coding plan key).
- Update pricing values in `models.json` if you need exact cost tracking.
- Referral link for MiniMax Coding Plan (10% off): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- See [/concepts/model-providers](/concepts/model-providers) for provider rules.
- Use `openclaw models list` and `openclaw models set minimax/MiniMax-M2.5` to switch.

## Troubleshooting

### “Unknown model: minimax/MiniMax-M2.5”

This usually means the **MiniMax provider isn’t configured** (no provider entry
and no MiniMax auth profile/env key found). A fix for this detection is in
**2026.1.12** (unreleased at the time of writing). Fix by:

- Upgrading to **2026.1.12** (or run from source `main`), then restarting the gateway.
- Running `openclaw configure` and selecting **MiniMax M2.5**, or
- Adding the `models.providers.minimax` block manually, or
- Setting `MINIMAX_API_KEY` (or a MiniMax auth profile) so the provider can be injected.

Make sure the model id is **case‑sensitive**:

- `minimax/MiniMax-M2.5`
- `minimax/MiniMax-M2.5-highspeed`

Then recheck with:

```bash
openclaw models list
```
