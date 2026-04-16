---
name: willow-memory-health
description: Audit an OpenClaw agent's memory for staleness, redundancy, dark records, and contradictions. Use when a user asks to check memory health, clean up old memories, find duplicate entries, or diagnose why a memory isn't surfacing in search. Reports HOT/WARM/STALE/DEAD buckets with actionable recommendations.
metadata:
  { "openclaw": { "emoji": "🧠", "os": ["darwin", "linux"], "requires": { "bins": ["python3"] } } }
---

# Willow Memory Health

Audit an OpenClaw agent's memory files for four failure modes that silently degrade memory quality over time:

| Signal            | What it means                                                                    |
| ----------------- | -------------------------------------------------------------------------------- |
| **STALE / DEAD**  | File hasn't been updated in 30+ / 90+ days — may no longer reflect current state |
| **REDUNDANT**     | Two or more files cover the same subject (Jaccard similarity ≥ 0.55 on titles)   |
| **DARK**          | File exists in memory but doesn't surface when searched — invisible to the agent |
| **CONTRADICTION** | Same file contains opposing status words (e.g. "deployed" and "not deployed")    |

## Trigger

Use this skill when the user:

- Asks to audit, clean up, or review memory
- Reports that the agent "forgot" something that should be in memory
- Wants to know which memories are stale or duplicated
- Asks why a memory isn't being retrieved

## Step 1 — Find the memory directory

Ask for confirmation or infer from context. The memory directory is typically one of:

- `<workspace>/memory/` — workspace-scoped memory files
- `~/.openclaw/agents/<agentId>/memory/` — agent-level memory

If neither is clear, ask: _"Where are your memory files stored? (e.g. a `memory/` folder in your workspace, or a path you specify)"_

## Step 2 — Run the diagnostic script

Run the bundled script against the memory directory:

```bash
python3 {baseDir}/scripts/memory_health.py --dir <memory-dir> --limit 50
```

Optional flags:

- `--limit N` — score only the N most recently modified files (default: 50)
- `--qmd` — enable DARK detection via `qmd query` (requires qmd CLI installed)
- `--json` — machine-readable output

If qmd is available and the user wants DARK detection:

```bash
python3 {baseDir}/scripts/memory_health.py --dir <memory-dir> --limit 50 --qmd
```

## Step 3 — Interpret the report

The script prints a per-file table and a summary:

```
WILLOW MEMORY HEALTH — memory/ (50 files)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FILE                    BUCKET   FLAGS
MEMORY.md               HOT      OK
2026-04-16.md           HOT      OK
2026-03-01.md           WARM     REDUNDANT
2026-03-01b.md          WARM     REDUNDANT
2025-12-10.md           DEAD     STALE | DARK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SUMMARY
  Files scored   : 50
  HOT  (<7d)     : 12
  WARM (7–30d)   : 23
  STALE (30–90d) : 11
  DEAD (>90d)    : 4
  REDUNDANT pairs: 3
  DARK           : 2  (qmd search returned no match)
  CONTRADICTION  : 1
```

**HOT/WARM** — healthy, no action needed.

**STALE** — review and either update or archive. Suggest: _"These files haven't been updated in 30–90 days. Want me to review them and mark outdated sections?"_

**DEAD** — strong candidate for archiving. Ask the user: _"These files are 90+ days old. Should I move them to an `archive/` subfolder?"_

**REDUNDANT** — two files covering the same subject. Suggest merging the newer into the older or vice versa. Show both filenames and ask which to keep.

**DARK** — file exists but qmd search can't find it. This usually means the QMD index is out of date. Suggest running `qmd update` or re-indexing: `openclaw memory sync`.

**CONTRADICTION** — file contains opposing status phrases. Show the specific pairs flagged (e.g. "deployed" vs "not deployed") and ask the user to clarify current state.

## Step 4 — Offer cleanup options

After reporting, offer numbered actions the user can pick:

1. Archive all DEAD files (move to `memory/archive/`)
2. Show REDUNDANT pairs for manual review
3. Update QMD index to fix DARK records (`qmd update`)
4. Show CONTRADICTION files for editing
5. Skip — report only, no changes

Always confirm before moving or modifying files.

## Step 5 — Execute with confirmation

For each cleanup action:

- Show exactly which files will be moved or modified
- Confirm before proceeding
- Report what was done

After cleanup, offer to re-run the diagnostic to confirm the health score improved.

## Memory writes

If the user has opted into memory writes, append a dated summary to `memory/YYYY-MM-DD.md`:

```
## Memory health audit — {timestamp}
- Files scored: N
- DEAD archived: N files → memory/archive/
- REDUNDANT merged: N pairs
- DARK fixed: N (qmd update run)
- CONTRADICTION resolved: N files
```

Append-only. Do not overwrite existing entries.

## Notes

- `MEMORY.md` and undated files in `memory/` are treated as evergreen — they are scored for REDUNDANT and CONTRADICTION but never flagged STALE/DEAD.
- Files outside the `memory/YYYY-MM-DD.md` naming convention use `mtime` for age calculation.
- DARK detection requires qmd CLI. If unavailable, the DARK column is skipped and noted in the report.
- This skill does not modify the QMD index directly — it reports and suggests; the user confirms all changes.
