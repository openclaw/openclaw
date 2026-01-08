---
summary: "Frequently asked questions about Clawdbot setup, configuration, and usage"
---
# FAQ

Quick answers plus deeper troubleshooting for real-world setups (local dev, VPS, multi-agent, OAuth/API keys, model failover). For the full config reference, see [Configuration](/gateway/configuration).

## What is Clawdbot?

### What is Clawdbot, in one paragraph?

Clawdbot is a personal AI assistant you run on your own devices. It replies on the messaging surfaces you already use (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, WebChat) and can also do voice + a live Canvas on supported platforms. The **Gateway** is the always‑on control plane; the assistant is the product.

## Quick start and first‑run setup

### What’s the recommended way to install and set up Clawdbot?

The repo recommends running from source and using the onboarding wizard:

```bash
git clone https://github.com/clawdbot/clawdbot.git
cd clawdbot

pnpm install

# Optional if you want built output / global linking:
pnpm build

# If the Control UI assets are missing or you want the dashboard:
pnpm ui:install
pnpm ui:build

pnpm clawdbot onboard
```

The wizard can also build UI assets automatically. After onboarding, you typically run the Gateway on port **18789**.

### What runtime do I need?

Node **>= 22** is required. `pnpm` is recommended; `bun` is optional.

### What does the onboarding wizard actually do?

`clawdbot onboard` is the recommended setup path. In **local mode** it walks you through:

- **Model/auth setup** (Anthropic OAuth recommended, OpenAI Codex OAuth supported, API keys optional, LM Studio local models supported)
- **Workspace** location + bootstrap files
- **Gateway settings** (bind/port/auth/tailscale)
- **Providers** (WhatsApp, Telegram, Discord, Signal, iMessage)
- **Daemon install** (LaunchAgent on macOS; systemd user unit on Linux/WSL2)
- **Health checks** and **skills** selection

It also warns if your configured model is unknown or missing auth.

### Can I use Bun?

Bun is supported for faster TypeScript execution, but **WhatsApp requires Node** in this ecosystem. The wizard lets you pick the runtime; choose **Node** if you use WhatsApp.

## Where things live on disk

### Where does Clawdbot store its data?

Everything lives under `~/.clawdbot/` (or `$CLAWDBOT_STATE_DIR` if you override the state dir):

| Path | Purpose |
|------|---------|
| `~/.clawdbot/clawdbot.json` | Main config (JSON5) |
| `~/.clawdbot/credentials/oauth.json` | Legacy OAuth import (copied into auth profiles on first use) |
| `~/.clawdbot/agents/<agentId>/agent/auth-profiles.json` | Auth profiles (OAuth + API keys) |
| `~/.clawdbot/agents/<agentId>/agent/auth.json` | Runtime auth cache (managed automatically) |
| `~/.clawdbot/credentials/` | Provider state (e.g. `whatsapp/<accountId>/creds.json`) |
| `~/.clawdbot/agents/` | Per‑agent state (agentDir + sessions) |
| `~/.clawdbot/agents/<agentId>/sessions/` | Conversation history & state (per agent) |
| `~/.clawdbot/agents/<agentId>/sessions/sessions.json` | Session metadata (per agent) |

Legacy single‑agent path: `~/.clawdbot/agent/*` (migrated by `clawdbot doctor`).

Your **workspace** (AGENTS.md, memory files, skills, etc.) is separate and configured via `agent.workspace` (default: `~/clawd`).

## Config basics

### What format is the config? Where is it?

Clawdbot reads an optional **JSON5** config from:

```
~/.clawdbot/clawdbot.json
```

If the file is missing, it uses safe‑ish defaults (including a default workspace of `~/clawd`).

### Do I have to restart after changing config?

The Gateway watches the config and supports hot‑reload:

- `gateway.reload.mode: "hybrid"` (default): hot‑apply safe changes, restart for critical ones
- `hot`, `restart`, `off` are also supported

A full restart is required for `gateway`, `bridge`, `discovery`, and `canvasHost` changes.

### Is there an API / RPC way to apply config?

Yes. `config.apply` validates + writes the full config and restarts the Gateway as part of the operation.

### What’s a minimal “sane” config for a first install?

```json5
{
  agent: { workspace: "~/clawd" },
  whatsapp: { allowFrom: ["+15555550123"] }
}
```

This sets your workspace and restricts who can trigger the bot.

## Env vars and .env loading

### How does Clawdbot load environment variables?

Clawdbot reads env vars from the parent process (shell, launchd/systemd, CI, etc.) and additionally loads:

- `.env` from the current working directory
- a global fallback `.env` from `~/.clawdbot/.env` (aka `$CLAWDBOT_STATE_DIR/.env`)

Neither `.env` file overrides existing env vars.

### “I started the Gateway via a daemon and my env vars disappeared.” What now?

Two common fixes:

1) Put the missing keys in `~/.clawdbot/.env` so they’re picked up even when the daemon doesn’t inherit your shell env.
2) Enable shell import (opt‑in convenience):

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000
    }
  }
}
```

This runs your login shell and imports only missing expected keys (never overrides). Env var equivalents:
`CLAWDBOT_LOAD_SHELL_ENV=1`, `CLAWDBOT_SHELL_ENV_TIMEOUT_MS=15000`.

## Models: defaults, selection, aliases, switching

### What is the “default model”?

Clawdbot’s default model is whatever you set as:

```
agent.model.primary
```

Models are referenced as `provider/model` (example: `anthropic/claude-opus-4-5`). If you omit the provider, Clawdbot currently assumes `anthropic` as a temporary deprecation fallback — but you should still **explicitly** set `provider/model`.

### How do I switch models on the fly (without restarting)?

Use the `/model` command as a standalone message:

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

You can list available models with `/model`, `/model list`, or `/model status`.

### Are opus / sonnet / gpt built‑in shortcuts?

Yes. Clawdbot ships a few default shorthands (only applied when the model exists in `agent.models`):

- `opus` → `anthropic/claude-opus-4-5`
- `sonnet` → `anthropic/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`

If you set your own alias with the same name, your value wins.

### How do I define/override model shortcuts (aliases)?

Aliases come from `agent.models.<modelId>.alias`. Example:

```json5
{
  agent: {
    model: { primary: "anthropic/claude-opus-4-5" },
    models: {
      "anthropic/claude-opus-4-5": { alias: "opus" },
      "anthropic/claude-sonnet-4-5": { alias: "sonnet" },
      "anthropic/claude-haiku-4-5": { alias: "haiku" }
    }
  }
}
```

Then `/model sonnet` (or `/<alias>` when supported) resolves to that model ID.

### How do I add models from other providers like OpenRouter or Z.AI?

OpenRouter (pay‑per‑token; many models):

```json5
{
  agent: {
    model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
    models: { "openrouter/anthropic/claude-sonnet-4-5": {} }
  },
  env: { OPENROUTER_API_KEY: "sk-or-..." }
}
```

Z.AI (GLM models):

```json5
{
  agent: {
    model: { primary: "zai/glm-4.7" },
    models: { "zai/glm-4.7": {} }
  },
  env: { ZAI_API_KEY: "..." }
}
```

If you reference a provider/model but the required provider key is missing, you’ll get a runtime auth error (e.g. `No API key found for provider "zai"`).

## Model failover and “All models failed”

### How does failover work?

Failover happens in two stages:

1) **Auth profile rotation** within the same provider.
2) **Model fallback** to the next model in `agent.model.fallbacks`.

Cooldowns apply to failing profiles (exponential backoff), so Clawdbot can keep responding even when a provider is rate‑limited or temporarily failing.

### What does this error mean?

```
No credentials found for profile "anthropic:default"
```

It means the system attempted to use the auth profile ID `anthropic:default`, but could not find credentials for it in the expected auth store.

### Fix checklist for `No credentials found for profile "anthropic:default"`

- **Confirm where auth profiles live** (new vs legacy paths)
  - Current: `~/.clawdbot/agents/<agentId>/agent/auth-profiles.json`
  - Legacy: `~/.clawdbot/agent/*` (migrated by `clawdbot doctor`)
- **Confirm your env var is loaded by the Gateway**
  - If you set `ANTHROPIC_API_KEY` in your shell but run the Gateway via systemd/launchd, it may not inherit it. Put it in `~/.clawdbot/.env` or enable `env.shellEnv`.
- **Make sure you’re editing the correct agent**
  - Multi‑agent setups mean there can be multiple `auth-profiles.json` files.
- **Sanity‑check model/auth status**
  - Use `/model status` to see configured models and whether providers are authenticated.

### Why did it also try Google Gemini and fail?

If your model config includes Google Gemini as a fallback (or you switched to a Gemini shorthand), Clawdbot will try it during model fallback. If you haven’t configured Google credentials, you’ll see `No API key found for provider "google"`.

Fix: either provide Google auth, or remove/avoid Google models in `agent.model.fallbacks` / aliases so fallback doesn’t route there.

## Auth profiles: what they are and how to manage them

### What is an auth profile?

An auth profile is a named credential record (OAuth or API key) tied to a provider. Profiles live in:

```
~/.clawdbot/agents/<agentId>/agent/auth-profiles.json
```

### What are typical profile IDs?

Clawdbot uses provider‑prefixed IDs like:

- `anthropic:default` (common when no email identity exists)
- `anthropic:<email>` for OAuth identities
- custom IDs you choose (e.g. `anthropic:work`)

### Can I control which auth profile is tried first?

Yes. Config supports optional metadata for profiles and an ordering per provider (`auth.order.<provider>`). This does **not** store secrets; it maps IDs to provider/mode and sets rotation order.

### OAuth vs API key: what’s the difference?

Clawdbot supports both:

- **OAuth** often leverages subscription access (where applicable).
- **API keys** use pay‑per‑token billing.

The wizard explicitly supports Anthropic OAuth and OpenAI Codex OAuth and can store API keys for you.

## Gateway: ports, “already running”, and remote mode

### What port does the Gateway use?

`gateway.port` controls the single multiplexed port for WebSocket + HTTP (Control UI, hooks, etc.).

Precedence:

```
--port > CLAWDBOT_GATEWAY_PORT > gateway.port > default 18789
```

### What does “another gateway instance is already listening” mean?

Clawdbot enforces a runtime lock by binding the WebSocket listener immediately on startup (default `ws://127.0.0.1:18789`). If the bind fails with `EADDRINUSE`, it throws `GatewayLockError` indicating another instance is already listening.

Fix: stop the other instance, free the port, or run with `clawdbot gateway --port <port>`.

### How do I run Clawdbot in remote mode (client connects to a Gateway elsewhere)?

Set `gateway.mode: "remote"` and point to a remote WebSocket URL, optionally with a token/password:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "your-token",
      password: "your-password"
    }
  }
}
```

Notes:
- `clawdbot gateway` only starts when `gateway.mode` is `local` (or you pass the override flag).
- The macOS app watches the config file and switches modes live when these values change.

### Can I run multiple Gateways on the same host?

Yes, but you must isolate:

- `CLAWDBOT_CONFIG_PATH` (per‑instance config)
- `CLAWDBOT_STATE_DIR` (per‑instance state)
- `agent.workspace` (workspace isolation)
- `gateway.port` (unique ports)

There are convenience CLI flags like `--dev` and `--profile <name>` that shift state dirs and ports.

## Logging and debugging

### Where are logs?

Default log file:

```
/tmp/clawdbot/clawdbot-YYYY-MM-DD.log
```

You can set a stable path via `logging.file`. File log level is controlled by `logging.level`. Console verbosity is controlled by `--verbose` and `logging.consoleLevel`.

### What’s the fastest way to get more details when something fails?

Start the Gateway with `--verbose` to get more console detail. Then inspect the log file for provider auth, model routing, and RPC errors.

## Security and access control

### Is it safe to expose Clawdbot to inbound DMs?

Treat inbound DMs as untrusted input. Defaults are designed to reduce risk:

- Default behavior on DM‑capable providers is **pairing**:
  - Unknown senders receive a pairing code; the bot does not process their message.
  - Approve with: `clawdbot pairing approve --provider <provider> <code>`
- Opening DMs publicly requires explicit opt‑in (`dmPolicy: "open"` and allowlist `"*"`).

Run `clawdbot doctor` to surface risky DM policies.

## Chat commands, aborting tasks, and “it won’t stop”

### How do I stop/cancel a running task?

Send any of these **as a standalone message** (no slash):

```
stop
abort
esc
wait
exit
```

These are abort triggers (not slash commands).

For background processes (from the bash tool), you can ask the agent to run:

```
process action:kill sessionId:XXX
```

Slash commands only run when the **entire** message is the command (must start with `/`). Inline text like `hello /status` is ignored.

### Why does it feel like the bot “ignores” rapid‑fire messages?

Queue mode controls how new messages interact with an in‑flight run. Use `/queue` to change modes:

- `steer` — new messages redirect the current task
- `followup` — run messages one at a time
- `collect` — batch messages and reply once (default)
- `steer-backlog` — steer now, then process backlog
- `interrupt` — abort current run and start fresh

You can add options like `debounce:2s cap:25 drop:summarize` for followup modes.

## Common troubleshooting

### “All models failed” — what should I check first?

- **Credentials** present for the provider(s) being tried (auth profiles + env vars).
- **Model routing**: confirm `agent.model.primary` and fallbacks are models you can access.
- **Gateway logs** in `/tmp/clawdbot/…` for the exact provider error.
- **`/model status`** to see current configured models + shorthands.

### WhatsApp logged me out. How do I re‑auth?

Run the login command again and scan the QR code:

```bash
clawdbot login
```

### Build errors on `main` — what’s the standard fix path?

1) `git pull origin main && pnpm install`
2) `pnpm clawdbot doctor`
3) Check GitHub issues or Discord
4) Temporary workaround: check out an older commit

## Answer the exact question from the screenshot/chat log

**Q: “What’s the default model for Anthropic with an API key?”**

**A:** In Clawdbot, credentials and model selection are separate. Setting `ANTHROPIC_API_KEY` (or storing an Anthropic API key in auth profiles) enables authentication, but the actual default model is whatever you configure in `agent.model.primary` (for example, `anthropic/claude-sonnet-4-5` or `anthropic/claude-opus-4-5`). If you see `No credentials found for profile "anthropic:default"`, it means the Gateway couldn’t find Anthropic credentials in the expected `auth-profiles.json` for the agent that’s running.

---

Still stuck? Ask in Discord or open a GitHub discussion.
