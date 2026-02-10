---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Doctor command: health checks, config migrations, and repair steps"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding or modifying doctor migrations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Introducing breaking config changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Doctor"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw doctor` is the repair + migration tool for OpenClaw. It fixes stale（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
config/state, checks health, and provides actionable repair steps.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Headless / automation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor --yes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Accept defaults without prompting (including restart/service/sandbox repair steps when applicable).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor --repair（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Apply recommended repairs without prompting (repairs + restarts where safe).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor --repair --force（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Apply aggressive repairs too (overwrites custom supervisor configs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor --non-interactive（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run without prompts and only apply safe migrations (config normalization + on-disk state moves). Skips restart/service/sandbox actions that require human confirmation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Legacy state migrations run automatically when detected.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor --deep（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Scan system services for extra gateway installs (launchd/systemd/schtasks).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want to review changes before writing, open the config file first:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cat ~/.openclaw/openclaw.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What it does (summary)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional pre-flight update for git installs (interactive only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI protocol freshness check (rebuilds Control UI when the protocol schema is newer).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Health check + restart prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skills status summary (eligible/missing/blocked).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config normalization for legacy values.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenCode Zen provider override warnings (`models.providers.opencode`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Legacy on-disk state migration (sessions/agent dir/WhatsApp auth).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- State integrity and permissions checks (sessions, transcripts, state dir).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config file permission checks (chmod 600) when running locally.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model auth health: checks OAuth expiry, can refresh expiring tokens, and reports auth-profile cooldown/disabled states.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Extra workspace dir detection (`~/openclaw`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sandbox image repair when sandboxing is enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Legacy service migration and extra gateway detection.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway runtime checks (service installed but not running; cached launchd label).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel status warnings (probed from the running gateway).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Supervisor config audit (launchd/systemd/schtasks) with optional repair.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway runtime best-practice checks (Node vs Bun, version-manager paths).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway port collision diagnostics (default `18789`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security warnings for open DM policies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway auth warnings when no `gateway.auth.token` is set (local mode; offers token generation).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- systemd linger check on Linux.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Source install checks (pnpm workspace mismatch, missing UI assets, missing tsx binary).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Writes updated config + wizard metadata.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Detailed behavior and rationale（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 0) Optional update (git installs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If this is a git checkout and doctor is running interactively, it offers to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
update (fetch/rebase/build) before running doctor.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1) Config normalization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the config contains legacy value shapes (for example `messages.ackReaction`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
without a channel-specific override), doctor normalizes them into the current（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
schema.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2) Legacy config key migrations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When the config contains deprecated keys, other commands refuse to run and ask（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
you to run `openclaw doctor`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Doctor will:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Explain which legacy keys were found.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Show the migration it applied.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Rewrite `~/.openclaw/openclaw.json` with the updated schema.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway also auto-runs doctor migrations on startup when it detects a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
legacy config format, so stale configs are repaired without manual intervention.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Current migrations:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `routing.allowFrom` → `channels.whatsapp.allowFrom`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `routing.queue` → `messages.queue`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `routing.bindings` → top-level `bindings`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `routing.agentToAgent` → `tools.agentToAgent`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `routing.transcribeAudio` → `tools.media.audio.models`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bindings[].match.accountID` → `bindings[].match.accountId`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `identity` → `agents.list[].identity`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agent.*` → `agents.defaults` + `tools.*` (tools/elevated/exec/sandbox/subagents)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2b) OpenCode Zen provider overrides（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you’ve added `models.providers.opencode` (or `opencode-zen`) manually, it（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
overrides the built-in OpenCode Zen catalog from `@mariozechner/pi-ai`. That can（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
force every model onto a single API or zero out costs. Doctor warns so you can（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
remove the override and restore per-model API routing + costs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3) Legacy state migrations (disk layout)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Doctor can migrate older on-disk layouts into the current structure:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions store + transcripts:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - from `~/.openclaw/sessions/` to `~/.openclaw/agents/<agentId>/sessions/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent dir:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - from `~/.openclaw/agent/` to `~/.openclaw/agents/<agentId>/agent/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp auth state (Baileys):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - from legacy `~/.openclaw/credentials/*.json` (except `oauth.json`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - to `~/.openclaw/credentials/whatsapp/<accountId>/...` (default account id: `default`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These migrations are best-effort and idempotent; doctor will emit warnings when（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
it leaves any legacy folders behind as backups. The Gateway/CLI also auto-migrates（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the legacy sessions + agent dir on startup so history/auth/models land in the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
per-agent path without a manual doctor run. WhatsApp auth is intentionally only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
migrated via `openclaw doctor`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 4) State integrity checks (session persistence, routing, and safety)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The state directory is the operational brainstem. If it vanishes, you lose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sessions, credentials, logs, and config (unless you have backups elsewhere).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Doctor checks:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **State dir missing**: warns about catastrophic state loss, prompts to recreate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  the directory, and reminds you that it cannot recover missing data.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **State dir permissions**: verifies writability; offers to repair permissions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (and emits a `chown` hint when owner/group mismatch is detected).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Session dirs missing**: `sessions/` and the session store directory are（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  required to persist history and avoid `ENOENT` crashes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Transcript mismatch**: warns when recent session entries have missing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  transcript files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Main session “1-line JSONL”**: flags when the main transcript has only one（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  line (history is not accumulating).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Multiple state dirs**: warns when multiple `~/.openclaw` folders exist across（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  home directories or when `OPENCLAW_STATE_DIR` points elsewhere (history can（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  split between installs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Remote mode reminder**: if `gateway.mode=remote`, doctor reminds you to run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  it on the remote host (the state lives there).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Config file permissions**: warns if `~/.openclaw/openclaw.json` is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  group/world readable and offers to tighten to `600`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 5) Model auth health (OAuth expiry)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Doctor inspects OAuth profiles in the auth store, warns when tokens are（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
expiring/expired, and can refresh them when safe. If the Anthropic Claude Code（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
profile is stale, it suggests running `claude setup-token` (or pasting a setup-token).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Refresh prompts only appear when running interactively (TTY); `--non-interactive`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
skips refresh attempts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Doctor also reports auth profiles that are temporarily unusable due to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- short cooldowns (rate limits/timeouts/auth failures)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- longer disables (billing/credit failures)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 6) Hooks model validation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `hooks.gmail.model` is set, doctor validates the model reference against the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
catalog and allowlist and warns when it won’t resolve or is disallowed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 7) Sandbox image repair（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When sandboxing is enabled, doctor checks Docker images and offers to build or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
switch to legacy names if the current image is missing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 8) Gateway service migrations and cleanup hints（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Doctor detects legacy gateway services (launchd/systemd/schtasks) and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
offers to remove them and install the OpenClaw service using the current gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
port. It can also scan for extra gateway-like services and print cleanup hints.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Profile-named OpenClaw gateway services are considered first-class and are not（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
flagged as "extra."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 9) Security warnings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Doctor emits warnings when a provider is open to DMs without an allowlist, or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
when a policy is configured in a dangerous way.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 10) systemd linger (Linux)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If running as a systemd user service, doctor ensures lingering is enabled so the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gateway stays alive after logout.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 11) Skills status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Doctor prints a quick summary of eligible/missing/blocked skills for the current（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
workspace.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 12) Gateway auth checks (local token)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Doctor warns when `gateway.auth` is missing on a local gateway and offers to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
generate a token. Use `openclaw doctor --generate-gateway-token` to force token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
creation in automation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 13) Gateway health check + restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Doctor runs a health check and offers to restart the gateway when it looks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
unhealthy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 14) Channel status warnings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the gateway is healthy, doctor runs a channel status probe and reports（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
warnings with suggested fixes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 15) Supervisor config audit + repair（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Doctor checks the installed supervisor config (launchd/systemd/schtasks) for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
missing or outdated defaults (e.g., systemd network-online dependencies and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
restart delay). When it finds a mismatch, it recommends an update and can（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
rewrite the service file/task to the current defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw doctor` prompts before rewriting supervisor config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw doctor --yes` accepts the default repair prompts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw doctor --repair` applies recommended fixes without prompts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw doctor --repair --force` overwrites custom supervisor configs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You can always force a full rewrite via `openclaw gateway install --force`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 16) Gateway runtime + port diagnostics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Doctor inspects the service runtime (PID, last exit status) and warns when the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
service is installed but not actually running. It also checks for port collisions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
on the gateway port (default `18789`) and reports likely causes (gateway already（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
running, SSH tunnel).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 17) Gateway runtime best practices（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Doctor warns when the gateway service runs on Bun or a version-managed Node path（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(`nvm`, `fnm`, `volta`, `asdf`, etc.). WhatsApp + Telegram channels require Node,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
and version-manager paths can break after upgrades because the service does not（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
load your shell init. Doctor offers to migrate to a system Node install when（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
available (Homebrew/apt/choco).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 18) Config write + wizard metadata（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Doctor persists any config changes and stamps wizard metadata to record the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
doctor run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 19) Workspace tips (backup + memory system)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Doctor suggests a workspace memory system when missing and prints a backup tip（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if the workspace is not already under git.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [/concepts/agent-workspace](/concepts/agent-workspace) for a full guide to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
workspace structure and git backup (recommended private GitHub or GitLab).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
