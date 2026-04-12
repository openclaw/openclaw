# rhinoroo/openclaw — Personal Operating Guide

This file is specific to the `rhinoroo/openclaw` fork. For full project guidelines
see `AGENTS.md` (the upstream project's guide, kept intact in this repo).

## Fork Purpose

Reduce runaway token/cost accumulation for a Windows-hosted OpenClaw instance
with Telegram as the primary chat interface and Claude (Haiku default, Sonnet
on demand) as the AI provider.

Active branch: `claude/automate-fork-sync-IR128`

## Fork Customizations (in main)

These features are specific to this fork and live in `main`:

- `session.reset.maxAgeHours` — hard wall-clock lifetime cap for sessions
- `session.reset.maxContextTokens` — token-budget reset trigger
- `sessionEntry.createdAt` — persisted session birth time enabling max-age enforcement
- Both values wired into `evaluateSessionFreshness()` in `src/config/sessions/reset.ts`

## My Config (applied via `openclaw config set`)

```jsonc
{
  "agents": { "defaults": { "model": "claude-haiku-4-5-20251001" } },
  "session": {
    "reset": {
      "mode": "idle",
      "idleMinutes": 90,
      "maxAgeHours": 12,
      "maxContextTokens": 80000
    },
    "resetByType": {
      "direct":  { "mode": "idle", "idleMinutes": 120, "maxAgeHours": 24 },
      "group":   { "mode": "idle", "idleMinutes": 30,  "maxAgeHours": 6  }
    },
    "maintenance": {
      "mode": "enforce",
      "pruneAfter": "7d",
      "maxEntries": 200
    }
  },
  "telegram": {
    "accounts": [{ "historyLimit": 15, "dmHistoryLimit": 20 }]
  }
}
```

## Daily Telegram Commands

| Command | What it does |
|---|---|
| `/status` | Show active session + model |
| `/usage cost` | Check token spend this session |
| `/reset` | Clear session and start fresh |
| `/compact` | Summarize context in place (cheaper than a reset) |
| `/model claude-sonnet-4-6` | Upgrade to Sonnet for this session |
| `/model claude-haiku-4-5-20251001` | Back to cheap default |
| `/session idle 2h` | Override idle timeout for this session |
| `/session max-age 6h` | Override max-age for this session |

## Build & Update Workflow (manual)

```powershell
# In the fork directory
git fetch upstream main
git merge --no-edit upstream/main
pnpm install
pnpm build

# Restart the Windows service
Stop-Service OpenClaw
Start-Service OpenClaw
```

## Gate Before Pushing

```bash
pnpm check
pnpm test src/config/sessions/reset.ts
pnpm test src/config/schema.help.quality.test.ts
pnpm config:docs:gen   # update hash after schema/help changes
```

## Key Files for Fork Customizations

| File | Role |
|---|---|
| `src/config/types.base.ts` | `SessionResetConfig` type |
| `src/config/zod-schema.session.ts` | Zod validation for config |
| `src/config/sessions/reset.ts` | `evaluateSessionFreshness()` enforcement |
| `src/config/sessions/types.ts` | `SessionEntry.createdAt` |
| `src/auto-reply/reply/session.ts` | Wires createdAt + totalTokens into freshness check |
| `src/config/schema.help.ts` | Help text for new config keys |
| `src/config/schema.labels.ts` | Labels for new config keys |

## Upstream Sync

`.github/workflows/upstream-sync.yml` automates daily syncing from `openclaw/openclaw`
upstream into this fork's `main`.

### How it works

| Scenario | Result |
|---|---|
| Fork `main` is already current | No action — logged and skipped |
| Upstream has new commits, no conflicts | Auto-merged into `main` and pushed |
| Upstream has new commits, conflicts detected | Branch `upstream-sync/YYYY-MM-DD` created + PR opened |

### Schedule

Runs daily at **06:00 UTC**. Also available as a manual trigger:
**Actions → Sync Fork with Upstream → Run workflow**

Use the **Dry run** checkbox to see the sync gap without actually merging.

### Required secret (optional, for branch-protected repos)

Create a fine-grained PAT with **Contents: write** + **Pull requests: write** scope
and store it as repo secret **`SYNC_TOKEN`**. Without it, the built-in `GITHUB_TOKEN`
is used, which works for unprotected `main` branches.

### When a conflict PR is opened

PR title: `chore: upstream sync — conflicts need manual resolution (XXXXXXX)`

**Resolution steps:**

```bash
git fetch origin
git checkout upstream-sync/YYYY-MM-DD   # the branch from the PR

# Merge fork customizations on top of the upstream state
git merge main
# Resolve any conflict markers (<<<<< / ===== / >>>>>)

git add .
git commit -m "chore: resolve upstream sync conflicts"
git push origin upstream-sync/YYYY-MM-DD
```

**Files to always keep our (fork) version of during conflict resolution:**

| File | Why |
|---|---|
| `CLAUDE.md` | Fork-only guide — upstream does not have this |
| `src/config/sessions/reset.ts` | Token-budget enforcement logic |
| `src/config/sessions/types.ts` | `SessionEntry.createdAt` field |
| `src/config/types.base.ts` | `SessionResetConfig` additions |
| `src/config/zod-schema.session.ts` | Zod schema additions |
| `src/auto-reply/reply/session.ts` | Freshness check wiring |

After pushing, approve and merge the PR.

### Manual sync (fallback or one-off)

```bash
git remote add upstream https://github.com/openclaw/openclaw.git  # once
git fetch upstream main
git merge --no-edit upstream/main
git push origin main
```

## Local Deploy Automation

A self-hosted GitHub Actions runner on the Windows machine picks up every push
to `main` — including daily upstream sync merges — and automatically stops the
service, pulls the latest, rebuilds, and restarts. No manual steps required.

### One-time setup

1. **Generate a runner registration token** (expires in 1 hour — do this right before step 2):
   GitHub repo → **Settings → Actions → Runners → New self-hosted runner**

2. **Run as Administrator** in PowerShell from the openclaw install directory:

   ```powershell
   .\scripts\setup-local-runner.ps1 `
     -RepoUrl     'https://github.com/rhinoroo/openclaw' `
     -Token       'AXXXXXXXXXXXXXXXXXX' `
     -OpenclawDir 'C:\path\to\openclaw'
   ```

3. In **Services.msc**, find the runner service
   (`actions.runner.rhinoroo-openclaw.openclaw-windows`) and change the
   **Log On** account to your admin account (so it has permission to stop/start OpenClaw).

4. Done. Every subsequent push to `main` will deploy automatically.

### What happens on every push to main

| Step | Action |
|---|---|
| 1 | GitHub notifies the runner |
| 2 | Runner calls `scripts\deploy-local.ps1` |
| 3 | OpenClaw service is stopped |
| 4 | `git fetch` + `git reset --hard origin/main` |
| 5 | `pnpm install --frozen-lockfile` |
| 6 | `pnpm build` |
| 7 | OpenClaw service is restarted |
| 8 | Result logged to `logs\deploy.log` |

If the build fails, the service restarts using the previous `dist/` artifacts.

### OpenClaw service failure recovery

The setup script configures the service to auto-restart on crash:
- Restart after 5 s on first failure
- Restart after 15 s on second failure
- Restart after 60 s on subsequent failures
- Failure count resets after 24 h

To apply manually:
```powershell
sc.exe failure OpenClaw reset=86400 actions=restart/5000/restart/15000/restart/60000
sc.exe failureflag OpenClaw 1
```

### Manual deploy trigger

**Actions → Deploy to Local Windows → Run workflow**

Use **Skip build** to restart the service without pulling or rebuilding (useful after config-only changes).

### Deploy log

```powershell
Get-Content "$env:OPENCLAW_DIR\logs\deploy.log" -Tail 50
```

### Runner management

```powershell
# Check status
Get-Service 'actions.runner.*'

# Restart the runner itself (not openclaw)
Restart-Service 'actions.runner.rhinoroo-openclaw.openclaw-windows'

# View runner logs
Get-EventLog -LogName Application -Source 'actions.runner.*' -Newest 20
```
