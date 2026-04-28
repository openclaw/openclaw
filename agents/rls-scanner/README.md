# rls-scanner

Weekly Row Level Security (RLS) leak scanner for Jeff's Supabase projects.

## What it does

1. Reads the Supabase access token from `~/.config/openclaw/supabase-token`.
2. Auto-discovers every project under the account (`GET /v1/projects`).
3. For each project, runs a SQL query against the Management API to list every
   `public` table along with its `rowsecurity` flag and policy count.
4. For every table with `rowsecurity = false`, fetches the project's anon key
   and probes the table via PostgREST (`?select=*&limit=1`).
   - `[ {...} ]` returned → **HIGH** (actively leaking data)
   - `[]` returned → **MEDIUM** (RLS off but table empty or empty-after-RLS)
   - 4xx → blocked (RLS effectively works, no finding)
5. Writes a full JSON report to `logs/scan-YYYY-MM-DD.json`.
6. If any HIGH findings are present, sends an iMessage alert to Jeff via the
   `imsg` CLI (falls back to email on failure).
7. Every other Monday with no findings, sends a "✅ all-clear" iMessage so Jeff
   knows the scanner is alive.

The scanner is **read-only**. It never enables RLS or applies policies.

## Setup

```bash
cd ~/code/openclaw/agents/rls-scanner
npm install
npm run build
```

## Manual run

```bash
node dist/index.js
# or, no notifications:
node dist/index.js --dry-run
```

## Install the weekly cron

```bash
./cron/install.sh
```

This installs a single idempotent crontab entry tagged `# rls-scanner` that runs
every Monday at 12:00 UTC (8 AM ET). Re-running the script replaces the entry.

## Files

- `src/index.ts` — orchestrator, log writer, notify dispatcher
- `src/list-projects.ts` — Supabase Management API project enumeration
- `src/scan-project.ts` — RLS-state SQL + anon-key probe
- `src/notify.ts` — iMessage send, email fallback, bi-weekly all-clear logic
- `src/util.ts` — shared HTTP/timeout helpers
- `src/types.ts` — shared types
- `data/allowlist.json` — table-name patterns to skip (strict by default: `[]`)
- `cron/install.sh` — idempotent crontab installer
- `logs/scan-YYYY-MM-DD.json` — per-run reports (gitignored)
- `logs/notify-state.json` — bi-weekly all-clear bookkeeping (gitignored)

## Allowlist format

`data/allowlist.json` is an array of exact table names or `prefix*` patterns.
Use sparingly — the default is empty, which means every public table without
RLS is flagged.

## Edge cases handled

- 401/403 from Supabase → iMessage Jeff to re-mint the token.
- Network timeout → one retry with 5 s delay.
- Project missing an anon key → recorded as `medium / no-anon-key`.
- Project not `ACTIVE_HEALTHY` → skipped, recorded with reason.
- New project under the account → auto-discovered next run.
