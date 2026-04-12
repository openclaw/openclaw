# rhinoroo/openclaw — Personal Operating Guide

This file is specific to the `rhinoroo/openclaw` fork. For full project guidelines
see `AGENTS.md` (the upstream project's guide, kept intact in this repo).

## Fork Purpose

Reduce runaway token/cost accumulation for a Windows-hosted OpenClaw instance
with Telegram as the primary chat interface and Claude (Haiku default, Sonnet
on demand) as the AI provider.

Active branch: `claude/reduce-token-usage-at4C2`

## What This Branch Adds

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
git rebase upstream/main
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

## Key Files for This Feature

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

```bash
git remote add upstream https://github.com/openclaw/openclaw  # once
git fetch upstream main
git rebase upstream/main
git push -u origin claude/reduce-token-usage-at4C2
```
