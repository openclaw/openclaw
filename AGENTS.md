# AGENTS.md — OpenClaw fork (blink-new/openclaw)

> This is Blink's fork of [openclaw/openclaw](https://github.com/openclaw/openclaw).
> It is tracked as a **git submodule** inside `auto-engineer/`.
> Full feature design → [`auto-engineer/.todo/blink-claw/PRD.md`](../.todo/blink-claw/PRD.md)
> AI Gateway design → [`auto-engineer/.todo/blink-claw/ai-gateway.md`](../.todo/blink-claw/ai-gateway.md)

---

## What This Repo Is

OpenClaw is an open-source AI agent framework (250K+ GitHub stars). It runs an always-on Node.js gateway that connects LLM models to your filesystem, shell, browser, and messaging apps (Telegram, Discord, Slack). Users interact via messaging apps. The agent runs 24/7, executes shell commands, installs packages, browses the web.

**Blink Claw** is Blink's managed hosting product for OpenClaw agents — one-click deploy on Fly.io, billed via Blink credits. This fork is the OpenClaw runtime that runs in each Fly.io Firecracker VM.

---

## Relationship to Original OpenClaw

| Concept | Detail |
|---------|--------|
| Upstream | `https://github.com/openclaw/openclaw.git` (remote: `upstream`) |
| Our fork | `https://github.com/blink-new/openclaw.git` (remote: `origin`) |
| Our diff | **~100 lines** — adds a `blink` LLM provider plugin only |
| License | MIT — we can fork and modify freely |

**Our changes are intentionally minimal.** The only additions are files that wire OpenClaw's LLM routing to the Blink AI Gateway. Everything else is upstream unchanged.

---

## Our Changes (What We Added)

Three new files + two modified:

### New: `src/providers/blink-shared.ts`
Blink provider constants — `BLINK_GATEWAY_BASE_URL` and `BLINK_MODEL_CATALOG` (model IDs in Vercel AI Gateway format: `anthropic/claude-sonnet-4-5`, `openai/gpt-5-1`, `google/gemini-3-flash`). Model `cost` set to 0 — Blink's gateway handles billing externally.

### New: `src/agents/blink-models.ts`
`buildBlinkProvider()` — returns the `ProviderConfig` for the `blink` provider. Follows the exact same pattern as `buildKilocodeProvider()` (in `src/agents/models-config.providers.static.ts`). Uses `api: "openai-completions"` so OpenClaw calls `POST {baseUrl}/chat/completions` in standard OpenAI format.

### Modified: `src/agents/models-config.providers.static.ts`
Export `buildBlinkProvider` from here.

### Modified: `src/agents/models-config.providers.ts`
Auto-activate Blink provider when `BLINK_CLAW_TOKEN` env var is set. Sets `anthropic/claude-sonnet-4-5` as the default model. No user config needed.

---

## Runtime Environment Variables

Injected per-container at Fly.io machine creation by Blink's Claw Manager:

| Variable | Value | Purpose |
|----------|-------|---------|
| `BLINK_CLAW_TOKEN` | `blnk_ak_{workspaceSuffix}_{random}` | Auth token for Blink AI Gateway. Activates the Blink provider. |
| `BLINK_APIS_URL` | `https://api.blink.new` | Blink AI Gateway base URL |
| `BLINK_AGENT_ID` | `clw_xxxxxxxx` | For per-agent usage tracking in Tinybird |
| `OPENCLAW_STATE_DIR` | `/data` | All state goes here (Fly Volume mounted at `/data`) |
| `OPENCLAW_GATEWAY_TOKEN` | random 32-char hex | Secures the gateway HTTP server |
| `OPENCLAW_HEADLESS` | `true` | No interactive prompts |

**`BLINK_CLAW_TOKEN` triggers everything.** When set, OpenClaw auto-registers the `blink` provider and sets it as the default. No `openclaw.json` config needed.

---

## How LLM Calls Flow

```
OpenClaw agent receives message (Telegram/Discord/Slack via outbound polling)
  → calls LLM via blink provider
  → POST https://api.blink.new/api/ai/gateway/v1/chat/completions
     Authorization: Bearer {BLINK_CLAW_TOKEN}
     Body: { model: "anthropic/claude-sonnet-4-5", messages: [...], stream: true }
  → blink-apis validates token → resolves workspace_id → calls gateway()
  → streams OpenAI SSE response back
  → blink-apis deducts credits from workspace (20% markup, same as all AI calls)
```

Model IDs use Vercel AI SDK gateway format (`provider/model-id`). The `gateway()` function in blink-apis accepts this directly — no translation.

---

## Deployment: Fly.io

Each Blink Claw agent = one Fly.io Firecracker VM. We use OpenClaw's own `fly.private.toml` as our template (no public HTTP service — headless for Phase 1):

```toml
OPENCLAW_STATE_DIR = "/data"
[mounts]
source = "blink_claw_{agentId}"
destination = "/data"   # Fly Volume — all state persists here
# No [http_service] block = no public URL (headless Phase 1)
```

**Storage:** Fly Volume at `/data`. Agent CWD = `/data/agents/default/agent/`. npm installs, files, packages the agent creates all persist here across restarts.

**Messaging:** Outbound polling only (no inbound ports needed). Telegram = `getUpdates` long-poll, Discord = WebSocket gateway. No webhook URL, no public IP.

**Docker image:** Built with `--build-arg OPENCLAW_INSTALL_BROWSER=1 --build-arg OPENCLAW_EXTENSIONS="telegram discord slack"`. Chromium baked into image layer (no download on restart).

---

## Git Workflow

### Working on Blink-specific changes

```bash
# Always work inside the openclaw/ submodule directory
cd openclaw/

# Create a branch for your changes
git checkout -b feat/blink-my-feature

# Make changes, commit to our fork
git add .
git commit -m "feat: ..."
git push origin feat/blink-my-feature

# After merge, update auto-engineer to point to new commit
cd ..
git add openclaw
git commit -m "chore: update openclaw submodule to include blink feature"
git push
```

### Pulling upstream OpenClaw updates

```bash
cd openclaw/

# Fetch latest from original openclaw/openclaw
git fetch upstream

# Merge upstream changes into our main branch
git checkout main
git merge upstream/main
# Fix any conflicts (rare — our diff is tiny)

# Push to our fork
git push origin main

# Update parent repo to point to new commit
cd ..
git add openclaw
git commit -m "chore: sync openclaw submodule with upstream v{version}"
```

### Cloning auto-engineer with submodules

```bash
# New clone — get everything including this submodule
git clone --recurse-submodules https://github.com/blink-new/auto-engineer.git

# Or if already cloned without --recurse-submodules:
git submodule update --init
```

---

## Key Files to Know

| File | Purpose |
|------|---------|
| `fly.toml` | Fly.io deploy config with public HTTP service (Phase 2) |
| `fly.private.toml` | Fly.io deploy config without public service (Phase 1 — headless) |
| `Dockerfile` | Multi-stage build. Use `OPENCLAW_INSTALL_BROWSER=1` and `OPENCLAW_EXTENSIONS` args |
| `src/providers/blink-shared.ts` | **Our addition** — Blink provider constants |
| `src/agents/blink-models.ts` | **Our addition** — `buildBlinkProvider()` |
| `src/agents/models-config.providers.ts` | **Modified** — auto-activates Blink when `BLINK_CLAW_TOKEN` set |
| `extensions/telegram/` | Telegram bot plugin (grammy, long-polling) |
| `extensions/discord/` | Discord bot plugin (WebSocket gateway) |
| `extensions/slack/` | Slack bot plugin |
| `src/config/paths.ts` | State directory resolution (`OPENCLAW_STATE_DIR`) |
| `src/node-host/invoke.ts` | Shell command executor (uses `spawn`/`spawnSync`) |

---

## Dev Commands

```bash
cd openclaw/

# Install deps
pnpm install

# Build
pnpm build:docker

# Run locally (for testing Blink provider)
BLINK_CLAW_TOKEN=blnk_ak_test_xxx \
BLINK_APIS_URL=http://localhost:3001 \
OPENCLAW_STATE_DIR=/tmp/openclaw-test \
node openclaw.mjs gateway --allow-unconfigured --port 18789

# Check health
curl http://localhost:18789/healthz
```

---

## Important Context for Future Agents

- **Do not change OpenClaw core files** unless absolutely necessary. Smaller diff = easier upgrades.
- **The `blink` provider follows the Kilocode pattern** exactly. If you need to understand how it works, read `src/providers/kilocode-shared.ts` and `src/agents/kilocode-models.ts` — Blink's provider is structured identically.
- **Model IDs must be in `provider/model-id` format.** blink-apis uses `gateway(modelId)` which expects this format natively. No translation.
- **Cost in model catalog = 0.** We set `cost: { input: 0, output: 0, ... }` so OpenClaw doesn't try to track token costs locally. Blink AI Gateway handles billing externally.
- **`OPENCLAW_STATE_DIR=/data` is critical.** If not set, state goes to `~/.openclaw/` which is in the container's ephemeral layer. Always set this to the mounted volume path.
