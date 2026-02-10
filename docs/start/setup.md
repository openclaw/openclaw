---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Advanced setup and development workflows for OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Setting up a new machine（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want “latest + greatest” without breaking your personal setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Setup"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you are setting up for the first time, start with [Getting Started](/start/getting-started).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For wizard details, see [Onboarding Wizard](/start/wizard).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Last updated: 2026-01-01（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## TL;DR（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Tailoring lives outside the repo:** `~/.openclaw/workspace` (workspace) + `~/.openclaw/openclaw.json` (config).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Stable workflow:** install the macOS app; let it run the bundled Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Bleeding edge workflow:** run the Gateway yourself via `pnpm gateway:watch`, then let the macOS app attach in Local mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Prereqs (from source)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node `>=22`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pnpm`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docker (optional; only for containerized setup/e2e — see [Docker](/install/docker))（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tailoring strategy (so updates don’t hurt)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want “100% tailored to me” _and_ easy updates, keep your customization in:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Config:** `~/.openclaw/openclaw.json` (JSON/JSON5-ish)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Workspace:** `~/.openclaw/workspace` (skills, prompts, memories; make it a private git repo)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bootstrap once:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
From inside this repo, use the local CLI entry:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you don’t have a global install yet, run it via `pnpm openclaw setup`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Run the Gateway from this repo（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After `pnpm build`, you can run the packaged CLI directly:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
node openclaw.mjs gateway --port 18789 --verbose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Stable workflow (macOS app first)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Install + launch **OpenClaw.app** (menu bar).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Complete the onboarding/permissions checklist (TCC prompts).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Ensure Gateway is **Local** and running (the app manages it).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Link surfaces (example: WhatsApp):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels login（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Sanity check:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw health（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If onboarding is not available in your build:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run `openclaw setup`, then `openclaw channels login`, then start the Gateway manually (`openclaw gateway`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Bleeding edge workflow (Gateway in a terminal)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Goal: work on the TypeScript Gateway, get hot reload, keep the macOS app UI attached.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 0) (Optional) Run the macOS app from source too（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you also want the macOS app on the bleeding edge:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
./scripts/restart-mac.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1) Start the dev Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm gateway:watch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`gateway:watch` runs the gateway in watch mode and reloads on TypeScript changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2) Point the macOS app at your running Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In **OpenClaw.app**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Connection Mode: **Local**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  The app will attach to the running gateway on the configured port.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3) Verify（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- In-app Gateway status should read **“Using existing gateway …”**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Or via CLI:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw health（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Common footguns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Wrong port:** Gateway WS defaults to `ws://127.0.0.1:18789`; keep app + CLI on the same port.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Where state lives:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Credentials: `~/.openclaw/credentials/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Sessions: `~/.openclaw/agents/<agentId>/sessions/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Logs: `/tmp/openclaw/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Credential storage map（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use this when debugging auth or deciding what to back up:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Telegram bot token**: config/env or `channels.telegram.tokenFile`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Discord bot token**: config/env (token file not yet supported)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Slack tokens**: config/env (`channels.slack.*`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Pairing allowlists**: `~/.openclaw/credentials/<channel>-allowFrom.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Model auth profiles**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Legacy OAuth import**: `~/.openclaw/credentials/oauth.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  More detail: [Security](/gateway/security#credential-storage-map).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Updating (without wrecking your setup)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep `~/.openclaw/workspace` and `~/.openclaw/` as “your stuff”; don’t put personal prompts/config into the `openclaw` repo.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Updating source: `git pull` + `pnpm install` (when lockfile changed) + keep using `pnpm gateway:watch`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Linux (systemd user service)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Linux installs use a systemd **user** service. By default, systemd stops user（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
services on logout/idle, which kills the Gateway. Onboarding attempts to enable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
lingering for you (may prompt for sudo). If it’s still off, run:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo loginctl enable-linger $USER（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For always-on or multi-user servers, consider a **system** service instead of a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
user service (no lingering needed). See [Gateway runbook](/gateway) for the systemd notes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Gateway runbook](/gateway) (flags, supervision, ports)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Gateway configuration](/gateway/configuration) (config schema + examples)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Discord](/channels/discord) and [Telegram](/channels/telegram) (reply tags + replyToMode settings)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [OpenClaw assistant setup](/start/openclaw)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [macOS app](/platforms/macos) (gateway lifecycle)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
