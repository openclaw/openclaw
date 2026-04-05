---
summary: "CLI reference for `openclaw memory` (status/index/search/promote)"
read_when:
  - You want to index or search semantic memory
  - You’re debugging memory availability or indexing
  - You want to promote recalled short-term memory into `MEMORY.md`
title: "memory"
---

# `openclaw memory`

Manage semantic memory indexing and search.
Provided by the active memory plugin (default: `memory-core`; set `plugins.slots.memory = "none"` to disable).

Related:

- Memory concept: [Memory](/concepts/memory)
- Plugins: [Plugins](/tools/plugin)

## Examples

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --fix
openclaw memory index --force
openclaw memory search "meeting notes"
openclaw memory search --query "deployment" --max-results 20
openclaw memory promote --limit 10 --min-score 0.75
openclaw memory promote --apply
openclaw memory promote --json --min-recall-count 0 --min-unique-queries 0
openclaw memory status --json
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory status --agent main
openclaw memory index --agent main --verbose
openclaw memory promote-explain "router vlan"
openclaw memory rem-harness --json
```

## Options

`memory status` and `memory index`:

- `--agent <id>`: scope to a single agent. Without it, these commands run for each configured agent; if no agent list is configured, they fall back to the default agent.
- `--verbose`: emit detailed logs during probes and indexing.

`memory status`:

- `--deep`: probe vector + embedding availability.
- `--index`: run a reindex if the store is dirty (implies `--deep`).
- `--fix`: repair stale recall locks and normalize promotion metadata.
- `--json`: print JSON output.

`memory index`:

- `--force`: force a full reindex.

`memory search`:

- Query input: pass either positional `[query]` or `--query <text>`.
- If both are provided, `--query` wins.
- If neither is provided, the command exits with an error.
- `--agent <id>`: scope to a single agent (default: the default agent).
- `--max-results <n>`: limit the number of results returned.
- `--min-score <n>`: filter out low-score matches.
- `--json`: print JSON results.

`memory promote`:

Preview and apply short-term memory promotions.

```bash
openclaw memory promote [--apply] [--limit <n>] [--include-promoted]
```

- `--apply` -- write promotions to `MEMORY.md` (default: preview only).
- `--limit <n>` -- cap the number of candidates shown.
- `--include-promoted` -- include entries already promoted in previous cycles.

Full options:

- Ranks short-term candidates from `memory/YYYY-MM-DD.md` using weighted recall signals (`frequency`, `relevance`, `query diversity`, `recency`).
- Uses recall events captured when `memory_search` returns daily-memory hits.
- When dreaming is enabled, `memory-core` auto-manages a cron job for the deep phase that triggers promotion in the background (no manual `openclaw cron add` required).
- `--agent <id>`: scope to a single agent (default: the default agent).
- `--limit <n>`: max candidates to return/apply.
- `--min-score <n>`: minimum weighted promotion score.
- `--min-recall-count <n>`: minimum recall count required for a candidate.
- `--min-unique-queries <n>`: minimum distinct query count required for a candidate.
- `--apply`: append selected candidates into `MEMORY.md` and mark them promoted.
- `--include-promoted`: include already promoted candidates in output.
- `--json`: print JSON output.

`memory promote-explain`:

Explain why a specific candidate would or would not promote, with a full score breakdown.

```bash
openclaw memory promote-explain "<selector>"
```

- `<selector>`: candidate key, path fragment, or snippet fragment to match.
- `--agent <id>`: scope to a single agent (default: the default agent).
- `--include-promoted`: include already promoted candidates.
- `--json`: print JSON output.

`memory rem-harness`:

Preview REM reflections, candidate truths, and deep promotion output without writing anything. Useful for staging and debugging the REM phase before it runs for real.

```bash
openclaw memory rem-harness [--json] [--agent <id>] [--include-promoted]
```

- `--agent <id>`: scope to a single agent (default: the default agent).
- `--include-promoted`: include already promoted deep candidates.
- `--json`: print JSON output.

See [Dreaming](/concepts/dreaming) for the full phase model and how REM fits in.

## Dreaming (experimental)

Dreaming is the background memory consolidation system with three cooperative
phases: **light** (organize into `DREAMS.md` in inline mode), **deep**
(promote into `MEMORY.md`), and **REM** (reflect and find patterns in
`DREAMS.md` in inline mode).

- Enable with `plugins.entries.memory-core.config.dreaming.enabled: true`.
- Toggle from chat with `/dreaming on|off` or `/dreaming enable|disable light|deep|rem`.
- Each phase runs on its own cron schedule, managed automatically by `memory-core`.
- Only the deep phase writes durable memory to `MEMORY.md`. With default inline storage, Light and REM write to `DREAMS.md`.
- Ranking uses weighted signals: recall frequency, retrieval relevance, query diversity, temporal recency, cross-day consolidation, and derived concept richness.
- Promotion re-reads the live daily note before writing to `MEMORY.md`, so edited or deleted short-term snippets do not get promoted from stale recall-store snapshots.
- Scheduled and manual `memory promote` runs share the same deep phase defaults unless you pass CLI threshold overrides.
- Automatic runs fan out across configured memory workspaces.

Default phase schedules:

- **Light**: every 6 hours (`0 */6 * * *`), `lookbackDays=2`, `limit=100`
- **Deep**: daily at 3 AM (`0 3 * * *`), `limit=10`, `minScore=0.8`, `minRecallCount=3`, `minUniqueQueries=3`, `recencyHalfLifeDays=14`
- **REM**: weekly, Sunday 5 AM (`0 5 * * 0`), `lookbackDays=7`, `limit=10`

Example:

```json
{
  "plugins": {
    "entries": {
      "memory-core": {
        "config": {
          "dreaming": {
            "enabled": true
          }
        }
      }
    }
  }
}
```

Notes:

- `memory index --verbose` prints per-phase details (provider, model, sources, batch activity).
- `memory status` includes any extra paths configured via `memorySearch.extraPaths`.
- If effectively active memory remote API key fields are configured as SecretRefs, the command resolves those values from the active gateway snapshot. If gateway is unavailable, the command fails fast.
- Gateway version skew note: this command path requires a gateway that supports `secrets.resolve`; older gateways return an unknown-method error.
- Override each phase schedule with `phases.<phase>.cron` and fine-tune deep promotion with `phases.deep.minScore`, `phases.deep.minRecallCount`, `phases.deep.minUniqueQueries`, `phases.deep.recencyHalfLifeDays`, and `phases.deep.maxAgeDays`.
- Set `plugins.entries.memory-core.config.dreaming.verboseLogging` to `true` to emit per-run candidate and apply details into the normal gateway logs while tuning the feature.
- See [Dreaming](/concepts/dreaming) for full phase descriptions and configuration reference.
