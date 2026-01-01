---
summary: "CLI onboarding wizard spec (gateway + workspace + skills + daemon)"
read_when:
  - Designing or implementing the onboarding wizard
  - Changing gateway install/setup flow
---

# Onboarding Wizard (CLI)

Goal: single interactive flow to set up Clawdis Gateway + workspace + skills on a new machine.
Uses `@clack/prompts` for arrow-key selection and step UX.

Scope: **Local gateway only**. Remote mode is **info-only** (no config writes).

## Entry points

- `clawdis onboard` (primary)
- `clawdis setup --wizard` (alias)

## Non-interactive mode

`--non-interactive` + flags to skip prompts. `--json` outputs a machine summary.

## Preflight

- Runtime: Node >=22 (reuse `runtime-guard`).
- Detect existing files:
  - config: `~/.clawdis/clawdis.json`
  - creds: `~/.clawdis/credentials/`
  - sessions: `~/.clawdis/sessions/`
  - workspace: `~/clawd` (or configured)
- Detect available package managers: `npm`, `pnpm`, `bun`.
- Detect optional tools: `brew`, `uv`, `go`.

If config exists:
- Prompt: **Keep / Modify / Reset**

Reset uses `trash` (never `rm`).

## Flow (interactive)

1) **Mode**
   - Local (full wizard)
   - Remote (info-only; no config writes)

2) **Model/Auth (local only)**
   - Anthropic OAuth (recommended)
   - API key
   - Minimax M2.1 (LM Studio; recommended local model)
   - Skip

3) **Workspace + config**
   - Default workspace: `~/clawd`
   - Writes `agent.workspace` into `~/.clawdis/clawdis.json`
   - Ensures sessions dir exists

4) **Gateway config**
   - Port (default 18789)
   - Bind: loopback | lan | tailnet | auto
   - Auth: token | password | off
   - Tailscale: off | serve | funnel

5) **Providers (optional)**
   - WhatsApp: optional `clawdis login` QR flow
   - Telegram: bot token (config or env)
   - Discord: bot token (config or env)
   - Signal: `signal-cli` detection + account config

6) **Daemon install (local only)**
   - macOS: LaunchAgent
   - Linux: systemd user unit
   - Windows: Scheduled Task

7) **Health**
   - Start/restart daemon
   - `clawdis health` summary

8) **Skills (recommended)**
   - Read from `buildWorkspaceSkillStatus`
   - Show eligible vs missing requirements
   - Offer installs via preferred installer
   - Allow skip

9) **Finish**
   - Summary + next steps
   - Reminder: iOS/Android/macOS node apps add canvas/camera/screen/system features.

## Remote mode (info-only)

- Explain where gateway runs.
- Show required steps on gateway host:
  - `clawdis setup`
  - `clawdis gateway-daemon ...`
  - OAuth file: `~/.clawdis/credentials/oauth.json`
  - Workspace: `~/clawd`
- No local config changes.

## Config writes

Wizard writes:
- `~/.clawdis/clawdis.json`
  - `agent.workspace`
  - `agent.model` + `models.providers` (if Minimax selected)
  - `skills.install.nodeManager` (npm | pnpm | bun)
  - `skills.entries.<key>.env` / `.apiKey` (if set in skills step)
  - `telegram.botToken`, `discord.token`, `signal.*` (if set in providers step)

WhatsApp login writes credentials to `~/.clawdis/credentials/creds.json`.

## Minimax M2.1 (LM Studio) config snippet

```json5
{
  agent: {
    model: "Minimax",
    allowedModels: [
      "anthropic/claude-opus-4-5",
      "lmstudio/minimax-m2.1-gs32"
    ],
    modelAliases: {
      Opus: "anthropic/claude-opus-4-5",
      Minimax: "lmstudio/minimax-m2.1-gs32"
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

## Skills install preferences

Prompt for node manager:
- npm
- pnpm
- bun

Writes:

```json5
{
  skills: {
    install: {
      nodeManager: "npm" // npm | pnpm | bun
    }
  }
}
```

## Reset scope (decision required)

Options:
- A) Config only (`~/.clawdis/clawdis.json`)
- B) Config + credentials + sessions
- C) Full reset: config + credentials + sessions + workspace

Wizard should clearly list what will be removed and use `trash`.

## Open questions

- Confirm “Remote = info-only” is final.
- Confirm reset scope default (A/B/C).
