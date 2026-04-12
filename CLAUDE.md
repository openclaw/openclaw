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

## Build & Update Workflow

```powershell
# In the fork directory
git fetch upstream main
git merge --no-edit upstream/main
pnpm install
pnpm build

# Restart the Windows service
Stop-Service OpenClaw
# Update service binary path to: node dist/cli.js  (first time only)
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
