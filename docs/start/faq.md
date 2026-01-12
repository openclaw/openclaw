---
summary: "Frequently asked questions about Clawdbot setup, configuration, and usage"
---
# FAQ

Quick answers plus deeper troubleshooting for real-world setups (local dev, VPS, multi-agent, OAuth/API keys, model failover). For runtime diagnostics, see [Troubleshooting](/gateway/troubleshooting). For the full config reference, see [Configuration](/gateway/configuration).

## First 60 seconds if something's broken

1) **Quick status (first check)**
   ```bash
   clawdbot status
   ```
   Fast local summary: OS + update, gateway/daemon reachability, agents/sessions, provider config + runtime issues (when gateway is reachable).

2) **Pasteable report (safe to share)**
   ```bash
   clawdbot status --all
   ```
   Read-only diagnosis with log tail (tokens redacted).

3) **Daemon + port state**
   ```bash
   clawdbot daemon status
   ```
   Shows supervisor runtime vs RPC reachability, the probe target URL, and which config the daemon likely used.

4) **Deep probes**
   ```bash
   clawdbot status --deep
   ```
   Runs gateway health checks + provider probes (requires a reachable gateway). See [Health](/gateway/health).

5) **Tail the latest log**
   ```bash
   clawdbot logs --follow
   ```
   If RPC is down, fall back to:
   ```bash
   tail -f "$(ls -t /tmp/clawdbot/clawdbot-*.log | head -1)"
   ```
   File logs are separate from service logs; see [Logging](/logging) and [Troubleshooting](/gateway/troubleshooting).

6) **Run the doctor (repairs)**
   ```bash
   clawdbot doctor
   ```
   Repairs/migrates config/state + runs health checks. See [Doctor](/gateway/doctor).

7) **Gateway snapshot**
   ```bash
   clawdbot health --json
   clawdbot health --verbose   # shows the target URL + config path on errors
   ```
   Asks the running gateway for a full snapshot (WS-only). See [Health](/gateway/health).

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
pnpm ui:build # auto-installs UI deps on first run

pnpm clawdbot onboard
```

The wizard can also build UI assets automatically. After onboarding, you typically run the Gateway on port **18789**.

### What runtime do I need?

Node **>= 22** is required. `pnpm` is recommended; `bun` is optional.

### What does the onboarding wizard actually do?

`clawdbot onboard` is the recommended setup path. In **local mode** it walks you through:

- **Model/auth setup** (Anthropic **setup-token** recommended for Claude subscriptions, OpenAI Codex OAuth supported, API keys optional, LM Studio local models supported)
- **Workspace** location + bootstrap files
- **Gateway settings** (bind/port/auth/tailscale)
- **Providers** (WhatsApp, Telegram, Discord, Signal, iMessage)
- **Daemon install** (LaunchAgent on macOS; systemd user unit on Linux/WSL2)
- **Health checks** and **skills** selection

It also warns if your configured model is unknown or missing auth.

### How does Anthropic "setup-token" auth work?

The wizard can run `claude setup-token` on the gateway host (or you run it yourself), then stores the token as an auth profile for the **anthropic** provider. That profile is used for model calls the same way an API key or OAuth profile would be. If you already ran `claude setup-token`, pick **Anthropic token (paste setup-token)** and paste it. More detail: [OAuth](/concepts/oauth).

### Do you support Claude subscription auth (Claude Code OAuth)?

Yes. Clawdbot can **reuse Claude Code CLI credentials** (OAuth) and also supports **setup-token**. If you have a Claude subscription, we recommend **setup-token** on the gateway host for the most reliable long‑running setup (requires Claude Pro/Max + the `claude` CLI). OAuth reuse is supported, but avoid logging in separately via Clawdbot and Claude Code to prevent token conflicts. See [Anthropic](/providers/anthropic) and [OAuth](/concepts/oauth).

### Is AWS Bedrock supported?

Not currently. Clawdbot doesn’t ship a Bedrock provider today. If you must use Bedrock, the common workaround is an OpenAI‑compatible proxy in front of Bedrock, then point Clawdbot at that endpoint. See [Model providers](/providers/models) and [Model providers (full list)](/concepts/model-providers).

### How does Codex auth work?

Clawdbot supports **OpenAI Code (Codex)** via OAuth or by reusing your Codex CLI login (`~/.codex/auth.json`). The wizard can import the CLI login or run the OAuth flow and will set the default model to `openai-codex/gpt-5.2` when appropriate. See [Model providers](/concepts/model-providers) and [Wizard](/start/wizard).

### Is a local model OK for casual chats?

Usually no. Clawdbot needs large context + strong safety; small cards truncate and leak. If you must, run the **largest** MiniMax M2.1 build you can locally (LM Studio) and see [/gateway/local-models](/gateway/local-models). Smaller/quantized models increase prompt-injection risk — see [Security](/gateway/security).

### Can I use Bun?

Bun is supported for faster TypeScript execution, but **WhatsApp requires Node** in this ecosystem. The wizard lets you pick the runtime; choose **Node** if you use WhatsApp.

### Can multiple people use one WhatsApp number with different Clawdbots?

Yes, via **multi‑agent routing**. Bind each sender’s WhatsApp **DM** (peer `kind: "dm"`, sender E.164 like `+15551234567`) to a different `agentId`, so each person gets their own workspace and session store. Replies still come from the **same WhatsApp account**, and DM access control (`whatsapp.dmPolicy` / `whatsapp.allowFrom`) is global per WhatsApp account. See [Multi-Agent Routing](/concepts/multi-agent) and [WhatsApp](/providers/whatsapp).

### Can I run a "fast chat" agent and an "Opus for coding" agent?

Yes. Use multi‑agent routing: give each agent its own default model, then bind inbound routes (provider account or specific peers) to each agent. Example config lives in [Multi-Agent Routing](/concepts/multi-agent). See also [Models](/concepts/models) and [Configuration](/gateway/configuration).

### Does Homebrew work on Linux?

Yes. Homebrew supports Linux (Linuxbrew). Quick setup:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

If you run Clawdbot via systemd, ensure the service PATH includes `/home/linuxbrew/.linuxbrew/bin` (or your brew prefix) so `brew`-installed tools resolve in non‑login shells.

### Can I switch between npm and git installs later?

Yes. Install the other flavor, then run Doctor so the gateway service points at the new entrypoint.

From npm → git:

```bash
git clone https://github.com/clawdbot/clawdbot.git
cd clawdbot
pnpm install
pnpm build
pnpm clawdbot doctor
clawdbot daemon restart
```

From git → npm:

```bash
npm install -g clawdbot@latest
clawdbot doctor
clawdbot daemon restart
```

Doctor detects a gateway service entrypoint mismatch and offers to rewrite the service config to match the current install (use `--repair` in automation).

### How do I customize skills without keeping the repo dirty?

Use managed overrides instead of editing the repo copy. Put your changes in `~/.clawdbot/skills/<name>/SKILL.md` (or add a folder via `skills.load.extraDirs` in `~/.clawdbot/clawdbot.json`). Precedence is `<workspace>/skills` > `~/.clawdbot/skills` > bundled, so managed overrides win without touching git. Only upstream-worthy edits should live in the repo and go out as PRs.

### How do I install skills on Linux?

Use **ClawdHub** (CLI) or drop skills into your workspace. The macOS Skills UI isn’t available on Linux.

Install the ClawdHub CLI (pick one package manager):

```bash
npm i -g clawdhub
```

```bash
pnpm add -g clawdhub
```

```bash
bun add -g clawdhub
```

Install skills:

```bash
clawdhub install <skill-slug>
clawdhub update --all
```

ClawdHub installs into `./skills` under your current directory; Clawdbot treats that as `<workspace>/skills` on the next session. For shared skills across agents, place them in `~/.clawdbot/skills/<name>/SKILL.md`. Some skills expect binaries installed via Homebrew; on Linux that means Linuxbrew (see the Homebrew Linux FAQ entry above). See [Skills](/tools/skills) and [ClawdHub](/tools/clawdhub).

### Is there a dedicated sandboxing doc?

Yes. See [Sandboxing](/gateway/sandboxing). For Docker-specific setup (full gateway in Docker or sandbox images), see [Docker](/install/docker).

### How does memory work?

Clawdbot memory is just Markdown files in the agent workspace:
- Daily notes in `memory/YYYY-MM-DD.md`
- Curated long-term notes in `MEMORY.md` (main/private sessions only)

Clawdbot also runs a **silent pre-compaction memory flush** to remind the model
to write durable notes before auto-compaction. This only runs when the workspace
is writable (read-only sandboxes skip it). See [Memory](/concepts/memory).

## Where things live on disk

### Where does Clawdbot store its data?

Everything lives under `$CLAWDBOT_STATE_DIR` (default: `~/.clawdbot`):

| Path | Purpose |
|------|---------|
| `$CLAWDBOT_STATE_DIR/clawdbot.json` | Main config (JSON5) |
| `$CLAWDBOT_STATE_DIR/credentials/oauth.json` | Legacy OAuth import (copied into auth profiles on first use) |
| `$CLAWDBOT_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | Auth profiles (OAuth + API keys) |
| `$CLAWDBOT_STATE_DIR/agents/<agentId>/agent/auth.json` | Runtime auth cache (managed automatically) |
| `$CLAWDBOT_STATE_DIR/credentials/` | Provider state (e.g. `whatsapp/<accountId>/creds.json`) |
| `$CLAWDBOT_STATE_DIR/agents/` | Per‑agent state (agentDir + sessions) |
| `$CLAWDBOT_STATE_DIR/agents/<agentId>/sessions/` | Conversation history & state (per agent) |
| `$CLAWDBOT_STATE_DIR/agents/<agentId>/sessions/sessions.json` | Session metadata (per agent) |

Legacy single‑agent path: `~/.clawdbot/agent/*` (migrated by `clawdbot doctor`).

Your **workspace** (AGENTS.md, memory files, skills, etc.) is separate and configured via `agents.defaults.workspace` (default: `~/clawd`).

### How do I completely uninstall Clawdbot?

See the dedicated guide: [Uninstall](/install/uninstall).

### Can agents work outside the workspace?

Yes. The workspace is the **default cwd** and memory anchor, not a hard sandbox.
Relative paths resolve inside the workspace, but absolute paths can access other
host locations unless sandboxing is enabled. If you need isolation, use
[`agents.defaults.sandbox`](/gateway/sandboxing) or per‑agent sandbox settings. If you
want a repo to be the default working directory, point that agent’s
`workspace` to the repo root. The Clawdbot repo is just source code; keep the
workspace separate unless you intentionally want the agent to work inside it.

Example (repo as default cwd):

```json5
{
  agents: {
    defaults: {
      workspace: "~/Projects/my-repo"
    }
  }
}
```

### I’m in remote mode — where is the session store?

Session state is owned by the **gateway host**. If you’re in remote mode, the session store you care about is on the remote machine, not your local laptop. See [Session management](/concepts/session).

## Config basics

### What format is the config? Where is it?

Clawdbot reads an optional **JSON5** config from `$CLAWDBOT_CONFIG_PATH` (default: `~/.clawdbot/clawdbot.json`):

```
$CLAWDBOT_CONFIG_PATH
```

If the file is missing, it uses safe‑ish defaults (including a default workspace of `~/clawd`).

### I set `gateway.bind: "lan"` (or `"tailnet"`) and now nothing listens / the UI says unauthorized

Non-loopback binds **require auth**. Configure `gateway.auth.mode` + `gateway.auth.token` (or use `CLAWDBOT_GATEWAY_TOKEN`).

```json5
{
  gateway: {
    bind: "lan",
    auth: {
      mode: "token",
      token: "replace-me"
    }
  }
}
```

Notes:
- `gateway.remote.token` is for **remote CLI calls** only; it does not enable local gateway auth.
- The Control UI authenticates via `connect.params.auth.token` (stored in app/UI settings). Avoid putting tokens in URLs.

### Why do I need a token on localhost now?

The wizard generates a gateway token by default (even on loopback) so **local WS clients must authenticate**. This blocks other local processes from calling the Gateway. Paste the token into the Control UI settings (or your client config) to connect.

If you **really** want open loopback, remove `gateway.auth` from your config. Doctor can generate a token for you any time: `clawdbot doctor --generate-gateway-token`.

### Do I have to restart after changing config?

The Gateway watches the config and supports hot‑reload:

- `gateway.reload.mode: "hybrid"` (default): hot‑apply safe changes, restart for critical ones
- `hot`, `restart`, `off` are also supported

### How do I run a central Gateway with specialized workers across devices?

The common pattern is **one Gateway** (e.g. Raspberry Pi) plus **nodes** and **agents**:

- **Gateway (central):** owns providers (Signal/WhatsApp), routing, and sessions.
- **Nodes (devices):** Macs/iOS/Android connect as peripherals and expose local tools (`system.run`, `canvas`, `camera`).
- **Agents (workers):** separate brains/workspaces for special roles (e.g. “Hetzner ops”, “Personal data”).
- **Sub‑agents:** spawn background work from a main agent when you want parallelism.
- **TUI:** connect to the Gateway and switch agents/sessions.

Docs: [Nodes](/nodes), [Remote access](/gateway/remote), [Multi-Agent Routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/tui).

### Can the Clawdbot browser run headless?

Yes. It’s a config option:

```json5
{
  browser: { headless: true },
  agents: {
    defaults: {
      sandbox: { browser: { headless: true } }
    }
  }
}
```

Default is `false` (headful). Headless is more likely to trigger anti‑bot checks on some sites. See [Browser](/tools/browser).

## Remote gateways + nodes

### How do commands propagate between Telegram, the gateway, and nodes?

Telegram messages are handled by the **gateway**. The gateway runs the agent and
only then calls nodes over the **Bridge** when a node tool is needed:

Telegram → Gateway → Agent → `node.*` → Node → Gateway → Telegram

Nodes don’t see inbound provider traffic; they only receive bridge RPC calls.

### Do nodes run a gateway daemon?

No. Only **one gateway** should run per host. Nodes are peripherals that connect
to the gateway (iOS/Android nodes, or macOS “node mode” in the menubar app).

A full restart is required for `gateway`, `bridge`, `discovery`, and `canvasHost` changes.

### Is there an API / RPC way to apply config?

Yes. `config.apply` validates + writes the full config and restarts the Gateway as part of the operation.

### What’s a minimal “sane” config for a first install?

```json5
{
  agents: { defaults: { workspace: "~/clawd" } },
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

You can also define inline env vars in config (applied only if missing from the process env):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." }
  }
}
```

See [/environment](/environment) for full precedence and sources.

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

## Sessions & multiple chats

### How do I start a fresh conversation?

Send `/new` or `/reset` as a standalone message. See [Session management](/concepts/session).

### How do I completely reset Clawdbot (but keep it installed)?

Use the reset command:

```bash
clawdbot reset
```

Non-interactive full reset:

```bash
clawdbot reset --scope full --yes --non-interactive
```

Then re-run onboarding:

```bash
clawdbot onboard --install-daemon
```

Notes:
- The onboarding wizard also offers **Reset** if it sees an existing config. See [Wizard](/start/wizard).
- If you used profiles (`--profile` / `CLAWDBOT_PROFILE`), reset each state dir (defaults are `~/.clawdbot-<profile>`).
- Dev reset: `clawdbot gateway --dev --reset` (dev-only; wipes dev config + credentials + sessions + workspace).

### Do I need to add a “bot account” to a WhatsApp group?

No. Clawdbot runs on **your own account**, so if you’re in the group, Clawdbot can see it.
By default, group replies are blocked until you allow senders (`groupPolicy: "allowlist"`).

If you want only **you** to be able to trigger group replies:

```json5
{
  whatsapp: {
    groupPolicy: "allowlist",
    groupAllowFrom: ["+15551234567"]
  }
}
```

### Why doesn’t Clawdbot reply in a group?

Two common causes:
- Mention gating is on (default). You must @mention the bot (or match `mentionPatterns`).
- You configured `whatsapp.groups` without `"*"` and the group isn’t allowlisted.

See [Groups](/concepts/groups) and [Group messages](/concepts/group-messages).

### Do groups/threads share context with DMs?

Direct chats collapse to the main session by default. Groups/channels have their own session keys, and Telegram topics / Discord threads are separate sessions. See [Groups](/concepts/groups) and [Group messages](/concepts/group-messages).

## Models: defaults, selection, aliases, switching

### What is the “default model”?

Clawdbot’s default model is whatever you set as:

```
agents.defaults.model.primary
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

`/model` (and `/model list`) shows a compact, numbered picker. Select by number:

```
/model 3
```

You can also force a specific auth profile for the provider (per session):

```
/model opus@anthropic:claude-cli
/model opus@anthropic:default
```

Tip: `/model status` shows which agent is active, which `auth-profiles.json` file is being used, and which auth profile will be tried next.
It also shows the configured provider endpoint (`baseUrl`) and API mode (`api`) when available.

### Why do I see “Model … is not allowed” and then no reply?

If `agents.defaults.models` is set, it becomes the **allowlist** for `/model` and any
session overrides. Choosing a model that isn’t in that list returns:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

That error is returned **instead of** a normal reply. Fix: add the model to
`agents.defaults.models`, remove the allowlist, or pick a model from `/model list`.

### Are opus / sonnet / gpt built‑in shortcuts?

Yes. Clawdbot ships a few default shorthands (only applied when the model exists in `agents.defaults.models`):

- `opus` → `anthropic/claude-opus-4-5`
- `sonnet` → `anthropic/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`

If you set your own alias with the same name, your value wins.

### How do I define/override model shortcuts (aliases)?

Aliases come from `agents.defaults.models.<modelId>.alias`. Example:

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-5" },
      models: {
        "anthropic/claude-opus-4-5": { alias: "opus" },
        "anthropic/claude-sonnet-4-5": { alias: "sonnet" },
        "anthropic/claude-haiku-4-5": { alias: "haiku" }
      }
    }
  }
}
```

Then `/model sonnet` (or `/<alias>` when supported) resolves to that model ID.

### How do I add models from other providers like OpenRouter or Z.AI?

OpenRouter (pay‑per‑token; many models):

```json5
{
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
      models: { "openrouter/anthropic/claude-sonnet-4-5": {} }
    }
  },
  env: { OPENROUTER_API_KEY: "sk-or-..." }
}
```

Z.AI (GLM models):

```json5
{
  agents: {
    defaults: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} }
    }
  },
  env: { ZAI_API_KEY: "..." }
}
```

If you reference a provider/model but the required provider key is missing, you’ll get a runtime auth error (e.g. `No API key found for provider "zai"`).

## Model failover and “All models failed”

### How does failover work?

Failover happens in two stages:

1) **Auth profile rotation** within the same provider.
2) **Model fallback** to the next model in `agents.defaults.model.fallbacks`.

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
  - Use `clawdbot models status` to see configured models and whether providers are authenticated.

### Why did it also try Google Gemini and fail?

If your model config includes Google Gemini as a fallback (or you switched to a Gemini shorthand), Clawdbot will try it during model fallback. If you haven’t configured Google credentials, you’ll see `No API key found for provider "google"`.

Fix: either provide Google auth, or remove/avoid Google models in `agents.defaults.model.fallbacks` / aliases so fallback doesn’t route there.

## Auth profiles: what they are and how to manage them

Related: [/concepts/oauth](/concepts/oauth) (OAuth flows, token storage, multi-account patterns, CLI sync)

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

Clawdbot may temporarily skip a profile if it’s in a short **cooldown** (rate limits/timeouts/auth failures) or a longer **disabled** state (billing/insufficient credits). To inspect this, run `clawdbot models status --json` and check `auth.unusableProfiles`. Tuning: `auth.cooldowns.billingBackoffHours*`.

You can also set a **per-agent** order override (stored in that agent’s `auth-profiles.json`) via the CLI:

```bash
# Defaults to the configured default agent (omit --agent)
clawdbot models auth order get --provider anthropic

# Lock rotation to a single profile (only try this one)
clawdbot models auth order set --provider anthropic anthropic:claude-cli

# Or set an explicit order (fallback within provider)
clawdbot models auth order set --provider anthropic anthropic:claude-cli anthropic:default

# Clear override (fall back to config auth.order / round-robin)
clawdbot models auth order clear --provider anthropic
```

To target a specific agent:

```bash
clawdbot models auth order set --provider anthropic --agent main anthropic:claude-cli
```

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

### Why does `clawdbot daemon status` say `Runtime: running` but `RPC probe: failed`?

Because “running” is the **supervisor’s** view (launchd/systemd/schtasks). The RPC probe is the CLI actually connecting to the gateway WebSocket and calling `status`.

Use `clawdbot daemon status` and trust these lines:
- `Probe target:` (the URL the probe actually used)
- `Listening:` (what’s actually bound on the port)
- `Last gateway error:` (common root cause when the process is alive but the port isn’t listening)

### Why does `clawdbot daemon status` show `Config (cli)` and `Config (daemon)` different?

You’re editing one config file while the daemon is running another (often a `--profile` / `CLAWDBOT_STATE_DIR` mismatch).

Fix:
```bash
clawdbot daemon install --force
```
Run that from the same `--profile` / environment you want the daemon to use.

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

### The Control UI says “unauthorized” (or keeps reconnecting). What now?

Your gateway is running with auth enabled (`gateway.auth.*`), but the UI is not sending the matching token/password.

Facts (from code):
- The Control UI stores the token in browser localStorage key `clawdbot.control.settings.v1`.
- The UI can import `?token=...` (and/or `?password=...`) once, then strips it from the URL.

Fix:
- Set `gateway.auth.token` (or `CLAWDBOT_GATEWAY_TOKEN`) on the gateway host.
- In the Control UI settings, paste the same token (or refresh with a one-time `?token=...` link).

### I set `gateway.bind: "tailnet"` but it can’t bind / nothing listens

`tailnet` bind picks a Tailscale IP from your network interfaces (100.64.0.0/10). If the machine isn’t on Tailscale (or the interface is down), there’s nothing to bind to.

Fix:
- Start Tailscale on that host (so it has a 100.x address), or
- Switch to `gateway.bind: "loopback"` / `"lan"`.

### Can I run multiple Gateways on the same host?

Yes, but you must isolate:

- `CLAWDBOT_CONFIG_PATH` (per‑instance config)
- `CLAWDBOT_STATE_DIR` (per‑instance state)
- `agents.defaults.workspace` (workspace isolation)
- `gateway.port` (unique ports)

There are convenience CLI flags like `--dev` and `--profile <name>` that shift state dirs and ports.
When using profiles, service names are suffixed (`com.clawdbot.<profile>`, `clawdbot-gateway-<profile>.service`,
`Clawdbot Gateway (<profile>)`).

## Logging and debugging

### Where are logs?

File logs (structured):

```
/tmp/clawdbot/clawdbot-YYYY-MM-DD.log
```

You can set a stable path via `logging.file`. File log level is controlled by `logging.level`. Console verbosity is controlled by `--verbose` and `logging.consoleLevel`.

Fastest log tail:

```bash
clawdbot logs --follow
```

Service/supervisor logs (when the gateway runs via launchd/systemd):
- macOS: `$CLAWDBOT_STATE_DIR/logs/gateway.log` and `gateway.err.log` (default: `~/.clawdbot/logs/...`; profiles use `~/.clawdbot-<profile>/logs/...`)
- Linux: `journalctl --user -u clawdbot-gateway[-<profile>].service -n 200 --no-pager`
- Windows: `schtasks /Query /TN "Clawdbot Gateway (<profile>)" /V /FO LIST`

See [Troubleshooting](/gateway/troubleshooting#log-locations) for more.

### How do I start/stop/restart the Gateway daemon?

Use the daemon helpers:

```bash
clawdbot daemon status
clawdbot daemon restart
```

If you run the gateway manually, `clawdbot gateway --force` can reclaim the port. See [Gateway](/gateway).

### What’s the fastest way to get more details when something fails?

Start the Gateway with `--verbose` to get more console detail. Then inspect the log file for provider auth, model routing, and RPC errors.

## Media & attachments

### My skill generated an image/PDF, but nothing was sent

Outbound attachments from the agent must include a `MEDIA:<path-or-url>` line (on its own line). See [Clawdbot assistant setup](/start/clawd) and [Agent send](/tools/agent-send).

CLI sending:

```bash
clawdbot message send --to +15555550123 --message "Here you go" --media /path/to/file.png
```

Note: images are resized/recompressed (max side 2048px) to hit size limits. See [Images](/nodes/images).

## Security and access control

### Is it safe to expose Clawdbot to inbound DMs?

Treat inbound DMs as untrusted input. Defaults are designed to reduce risk:

- Default behavior on DM‑capable providers is **pairing**:
  - Unknown senders receive a pairing code; the bot does not process their message.
  - Approve with: `clawdbot pairing approve <provider> <code>`
  - Pending requests are capped at **3 per provider**; check `clawdbot pairing list <provider>` if a code didn’t arrive.
- Opening DMs publicly requires explicit opt‑in (`dmPolicy: "open"` and allowlist `"*"`).

Run `clawdbot doctor` to surface risky DM policies.

### WhatsApp: will it message my contacts? How does pairing work?

No. Default WhatsApp DM policy is **pairing**. Unknown senders only get a pairing code and their message is **not processed**. Clawdbot only replies to chats it receives or to explicit sends you trigger.

Approve pairing with:

```bash
clawdbot pairing approve whatsapp <code>
```

List pending requests:

```bash
clawdbot pairing list whatsapp
```

Wizard phone number prompt: it’s used to set your **allowlist/owner** so your own DMs are permitted. It’s not used for auto-sending. If you run on your personal WhatsApp number, use that number and enable `whatsapp.selfChatMode`.

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

For background processes (from the exec tool), you can ask the agent to run:

```
process action:kill sessionId:XXX
```

Slash commands overview: see [Slash commands](/tools/slash-commands).

Most commands must be sent as a **standalone** message that starts with `/`, but a few shortcuts (like `/status`) also work inline for allowlisted senders.

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
- **Model routing**: confirm `agents.defaults.model.primary` and fallbacks are models you can access.
- **Gateway logs** in `/tmp/clawdbot/…` for the exact provider error.
- **`/model status`** to see current configured models + shorthands.

### I’m running on my personal WhatsApp number — why is self-chat weird?

Enable self-chat mode and allowlist your own number:

```json5
{
  whatsapp: {
    selfChatMode: true,
    dmPolicy: "allowlist",
    allowFrom: ["+15555550123"]
  }
}
```

See [WhatsApp setup](/providers/whatsapp).

### WhatsApp logged me out. How do I re‑auth?

Run the login command again and scan the QR code:

```bash
clawdbot providers login
```

### Build errors on `main` — what’s the standard fix path?

1) `git pull origin main && pnpm install`
2) `pnpm clawdbot doctor`
3) Check GitHub issues or Discord
4) Temporary workaround: check out an older commit

## Answer the exact question from the screenshot/chat log

**Q: “What’s the default model for Anthropic with an API key?”**

**A:** In Clawdbot, credentials and model selection are separate. Setting `ANTHROPIC_API_KEY` (or storing an Anthropic API key in auth profiles) enables authentication, but the actual default model is whatever you configure in `agents.defaults.model.primary` (for example, `anthropic/claude-sonnet-4-5` or `anthropic/claude-opus-4-5`). If you see `No credentials found for profile "anthropic:default"`, it means the Gateway couldn’t find Anthropic credentials in the expected `auth-profiles.json` for the agent that’s running.

---

Still stuck? Ask in Discord or open a GitHub discussion.
