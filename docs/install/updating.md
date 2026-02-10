---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Updating OpenClaw safely (global install or source), plus rollback strategy"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Updating OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Something breaks after an update（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Updating"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Updating（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw is moving fast (pre “1.0”). Treat updates like shipping infra: update → run checks → restart (or use `openclaw update`, which restarts) → verify.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Recommended: re-run the website installer (upgrade in place)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The **preferred** update path is to re-run the installer from the website. It（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
detects existing installs, upgrades in place, and runs `openclaw doctor` when（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://openclaw.ai/install.sh | bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add `--no-onboard` if you don’t want the onboarding wizard to run again.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For **source installs**, use:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  The installer will `git pull --rebase` **only** if the repo is clean.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For **global installs**, the script uses `npm install -g openclaw@latest` under the hood.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Legacy note: `clawdbot` remains available as a compatibility shim.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Before you update（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Know how you installed: **global** (npm/pnpm) vs **from source** (git clone).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Know how your Gateway is running: **foreground terminal** vs **supervised service** (launchd/systemd).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Snapshot your tailoring:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Config: `~/.openclaw/openclaw.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Credentials: `~/.openclaw/credentials/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Workspace: `~/.openclaw/workspace`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Update (global install)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Global install (pick one):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
npm i -g openclaw@latest（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm add -g openclaw@latest（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
We do **not** recommend Bun for the Gateway runtime (WhatsApp/Telegram bugs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To switch update channels (git + npm installs):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update --channel beta（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update --channel dev（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update --channel stable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `--tag <dist-tag|version>` for a one-off install tag/version.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Development channels](/install/development-channels) for channel semantics and release notes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: on npm installs, the gateway logs an update hint on startup (checks the current channel tag). Disable via `update.checkOnStart: false`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw health（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If your Gateway runs as a service, `openclaw gateway restart` is preferred over killing PIDs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you’re pinned to a specific version, see “Rollback / pinning” below.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Update (`openclaw update`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For **source installs** (git checkout), prefer:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It runs a safe-ish update flow:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requires a clean worktree.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Switches to the selected channel (tag or branch).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fetches + rebases against the configured upstream (dev channel).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Installs deps, builds, builds the Control UI, and runs `openclaw doctor`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Restarts the gateway by default (use `--no-restart` to skip).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you installed via **npm/pnpm** (no git metadata), `openclaw update` will try to update via your package manager. If it can’t detect the install, use “Update (global install)” instead.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Update (Control UI / RPC)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Control UI has **Update & Restart** (RPC: `update.run`). It:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Runs the same source-update flow as `openclaw update` (git checkout only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Writes a restart sentinel with a structured report (stdout/stderr tail).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Restarts the gateway and pings the last active session with the report.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the rebase fails, the gateway aborts and restarts without applying the update.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Update (from source)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
From the repo checkout:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Preferred:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manual (equivalent-ish):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git pull（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm ui:build # auto-installs UI deps on first run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw health（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pnpm build` matters when you run the packaged `openclaw` binary ([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)) or use Node to run `dist/`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you run from a repo checkout without a global install, use `pnpm openclaw ...` for CLI commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you run directly from TypeScript (`pnpm openclaw ...`), a rebuild is usually unnecessary, but **config migrations still apply** → run doctor.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Switching between global and git installs is easy: install the other flavor, then run `openclaw doctor` so the gateway service entrypoint is rewritten to the current install.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Always Run: `openclaw doctor`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Doctor is the “safe update” command. It’s intentionally boring: repair + migrate + warn.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: if you’re on a **source install** (git checkout), `openclaw doctor` will offer to run `openclaw update` first.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Typical things it does:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Migrate deprecated config keys / legacy config file locations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Audit DM policies and warn on risky “open” settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check Gateway health and can offer to restart.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Detect and migrate older gateway services (launchd/systemd; legacy schtasks) to current OpenClaw services.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On Linux, ensure systemd user lingering (so the Gateway survives logout).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Details: [Doctor](/gateway/doctor)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Start / stop / restart the Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CLI (works regardless of OS):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway stop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway --port 18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you’re supervised:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS launchd (app-bundled LaunchAgent): `launchctl kickstart -k gui/$UID/bot.molt.gateway` (use `bot.molt.<profile>`; legacy `com.openclaw.*` still works)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Linux systemd user service: `systemctl --user restart openclaw-gateway[-<profile>].service`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Windows (WSL2): `systemctl --user restart openclaw-gateway[-<profile>].service`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `launchctl`/`systemctl` only work if the service is installed; otherwise run `openclaw gateway install`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Runbook + exact service labels: [Gateway runbook](/gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Rollback / pinning (when something breaks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Pin (global install)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install a known-good version (replace `<version>` with the last working one):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
npm i -g openclaw@<version>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm add -g openclaw@<version>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: to see the current published version, run `npm view openclaw version`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then restart + re-run doctor:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Pin (source) by date（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pick a commit from a date (example: “state of main as of 2026-01-01”):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git fetch origin（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then reinstall deps + restart:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want to go back to latest later:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git checkout main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git pull（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## If you’re stuck（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run `openclaw doctor` again and read the output carefully (it often tells you the fix).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check: [Troubleshooting](/gateway/troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ask in Discord: [https://discord.gg/clawd](https://discord.gg/clawd)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
