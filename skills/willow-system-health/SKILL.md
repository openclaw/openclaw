---
name: willow-system-health
description: Audit the Willow local AI stack for subsystem failures, drift, and resource bloat. Use when a user asks to check Willow health, diagnose a slow or broken Willow session, verify Postgres/Ollama/MCP are up, inspect open forks or tasks, or run a weekly deep diagnostic. Reports HEALTHY / WARN / CRITICAL per subsystem with actionable recommendations.
metadata:
  { "openclaw": { "emoji": "🏥", "os": ["linux", "darwin"], "requires": { "bins": ["python3"] } } }
---

# Willow System Health

Audit the Willow local AI stack across three cadenced tiers. Each tier adds depth — boot checks are instant, daily checks catch drift, weekly checks catch structural rot.

| Tier       | When to run                         | Focus                                                     |
| ---------- | ----------------------------------- | --------------------------------------------------------- |
| **boot**   | Every new session                   | Core services up, orphaned forks, open tasks              |
| **daily**  | Once per day                        | KB growth, session bloat, store bloat, dead Ollama models |
| **weekly** | Sunday or first session of the week | Fork audit, Postgres vacuum estimate, full diagnostics    |

## Trigger

Use this skill when the user:

- Asks to check, audit, or verify Willow health
- Reports Willow is slow, unresponsive, or giving stale answers
- Wants to know if Postgres, Ollama, or MCP are running
- Asks about open forks, open tasks, or store bloat
- Wants a weekly deep diagnostic

## Step 1 — Determine the tier

Ask or infer from context. Default to `boot` if the user just wants a quick check.

| User phrase                               | Tier   |
| ----------------------------------------- | ------ |
| "quick check", "is Willow up"             | boot   |
| "daily check", "how's the KB growing"     | daily  |
| "weekly", "deep check", "full diagnostic" | weekly |
| "all", "everything"                       | all    |

## Step 2 — Run the diagnostic script

```bash
python3 {baseDir}/scripts/system_health.py --check boot
python3 {baseDir}/scripts/system_health.py --check daily
python3 {baseDir}/scripts/system_health.py --check weekly
python3 {baseDir}/scripts/system_health.py --check all
```

Optional flags:

- `--willow-dir PATH` — override default `~/.willow/` store path
- `--repo PATH` — override default Willow git repo path (for fork audit)
- `--json` — machine-readable output

## Step 3 — Interpret the report

The script prints a per-subsystem table followed by a summary:

```
WILLOW SYSTEM HEALTH — boot (2026-04-24 09:15)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SUBSYSTEM          STATUS     DETAIL
Postgres           HEALTHY    connection ok
Ollama             HEALTHY    3 models loaded
MCP server         HEALTHY    responding at 127.0.0.1:7337
Orphaned forks     WARN       2 worktrees unmerged >7d
Open tasks         HEALTHY    4 open tasks
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SUMMARY
  Tier checked  : boot
  HEALTHY       : 3
  WARN          : 1
  CRITICAL      : 0
```

**HEALTHY** — no action needed.

**WARN** — review recommended. Suggest specific next action (see table below).

**CRITICAL** — service is down or threshold severely exceeded. Block-level recommendation.

| Flag                          | Suggested action                                                       |
| ----------------------------- | ---------------------------------------------------------------------- |
| Postgres CRITICAL             | Check `systemctl status postgresql` or `pg_lsclusters`                 |
| Ollama CRITICAL               | Run `ollama serve` or check `systemctl status ollama`                  |
| MCP CRITICAL                  | Run `willow restart` or check `~/.willow/server.log`                   |
| Orphaned forks WARN           | Show fork list, ask user which to merge or delete                      |
| Sessions WARN (>500)          | Run `willow jeles cleanup --dry-run` then confirm                      |
| Store collections WARN (>150) | Run `python3 scripts/system_health.py --check daily --json` for detail |
| Dead Ollama models WARN       | Run `ollama rm <model>` after confirmation                             |
| Postgres bloat WARN           | Run `VACUUM ANALYZE` in psql; schedule during off-hours                |

## Step 4 — Enforce config drift (boot tier)

The boot check includes a drift watchdog. If any of these fail, flag CRITICAL:

- Ollama reachable at `127.0.0.1:11434`
- MCP server socket alive (default `127.0.0.1:7337`)
- Postgres connection succeeds with default Willow credentials

Drift means something changed the environment — not the code. Check recent `git log`, system updates, or port conflicts first before spelunking source.

## Step 5 — Offer cleanup actions

After reporting, offer numbered actions the user can pick:

1. Merge or delete orphaned forks (show list first)
2. Archive old Jeles sessions (`willow jeles cleanup`)
3. Remove dead Ollama models (`ollama rm <model>`)
4. Run Postgres VACUUM ANALYZE
5. Skip — report only, no changes

Always confirm before any destructive action.

## Step 6 — Execute with confirmation

For each cleanup action:

- Show exactly what will be changed
- Confirm before proceeding
- Report what was done

After cleanup, offer to re-run the diagnostic to confirm health improved.

## Memory writes

If the user has opted into memory writes, append a dated summary to `memory/YYYY-MM-DD.md`:

```
## Willow system health — {timestamp}
- Tier: boot/daily/weekly
- CRITICAL: N subsystems
- WARN: N subsystems
- Actions taken: (list or "none")
```

Append-only. Do not overwrite existing entries.

## Notes

- Boot checks are safe to run at any time — read-only, no side effects.
- Daily and weekly checks may be slow (Postgres queries, git commands). Warn the user if running in a latency-sensitive session.
- Fork audit uses `git worktree list` in the Willow repo. Default path is `~/github/willow-1.9` — override with `--repo`.
- Ollama dead-model detection uses `ollama list` and compares to last-access timestamps if available; falls back to listing all models as WARN.
- This skill does not modify the Postgres schema or Willow config directly — it reports and suggests; the user confirms all changes.
