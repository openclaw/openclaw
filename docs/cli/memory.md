---
summary: "CLI reference for `mullusi memory` (status/index/search/promote)"
read_when:
  - You want to index or search semantic memory
  - You’re debugging memory availability or indexing
  - You want to promote recalled short-term memory into `MEMORY.md`
title: "memory"
---

# `mullusi memory`

Manage semantic memory indexing and search.
Provided by the active memory plugin (default: `memory-core`; set `plugins.slots.memory = "none"` to disable).

Related:

- Memory concept: [Memory](/concepts/memory)
- Plugins: [Plugins](/tools/plugin)

## Examples

```bash
mullusi memory status
mullusi memory status --deep
mullusi memory status --fix
mullusi memory index --force
mullusi memory search "meeting notes"
mullusi memory search --query "deployment" --max-results 20
mullusi memory promote --limit 10 --min-score 0.75
mullusi memory promote --apply
mullusi memory promote --json --min-recall-count 0 --min-unique-queries 0
mullusi memory status --json
mullusi memory status --deep --index
mullusi memory status --deep --index --verbose
mullusi memory status --agent main
mullusi memory index --agent main --verbose
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
mullusi memory promote [--apply] [--limit <n>] [--include-promoted]
```

- `--apply` -- write promotions to `MEMORY.md` (default: preview only).
- `--limit <n>` -- cap the number of candidates shown.
- `--include-promoted` -- include entries already promoted in previous cycles.

Full options:

- Ranks short-term candidates from `memory/YYYY-MM-DD.md` using weighted recall signals (`frequency`, `relevance`, `query diversity`, `recency`).
- Uses recall events captured when `memory_search` returns daily-memory hits.
- Optional auto-dreaming mode: when `plugins.entries.memory-core.config.dreaming.mode` is `core`, `deep`, or `rem`, `memory-core` auto-manages a cron job that triggers promotion in the background (no manual `mullusi cron add` required).
- `--agent <id>`: scope to a single agent (default: the default agent).
- `--limit <n>`: max candidates to return/apply.
- `--min-score <n>`: minimum weighted promotion score.
- `--min-recall-count <n>`: minimum recall count required for a candidate.
- `--min-unique-queries <n>`: minimum distinct query count required for a candidate.
- `--apply`: append selected candidates into `MEMORY.md` and mark them promoted.
- `--include-promoted`: include already promoted candidates in output.
- `--json`: print JSON output.

## Dreaming (experimental)

Dreaming is the overnight reflection pass for memory. It is called "dreaming" because the system revisits what was recalled during the day and decides what is worth keeping long-term.

- It is opt-in and disabled by default.
- Enable it with `plugins.entries.memory-core.config.dreaming.mode`.
- You can toggle modes from chat with `/dreaming off|core|rem|deep`. Run `/dreaming` (or `/dreaming options`) to see what each mode does.
- When enabled, `memory-core` automatically creates and maintains a managed cron job.
- Set `dreaming.limit` to `0` if you want dreaming enabled but automatic promotion effectively paused.
- Ranking uses weighted signals: recall frequency, retrieval relevance, query diversity, and temporal recency (recent recalls decay over time).
- Promotion into `MEMORY.md` only happens when quality thresholds are met, so long-term memory stays high signal instead of collecting one-off details.

Default mode presets:

- `core`: daily at `0 3 * * *`, `minScore=0.75`, `minRecallCount=3`, `minUniqueQueries=2`
- `deep`: every 12 hours (`0 */12 * * *`), `minScore=0.8`, `minRecallCount=3`, `minUniqueQueries=3`
- `rem`: every 6 hours (`0 */6 * * *`), `minScore=0.85`, `minRecallCount=4`, `minUniqueQueries=3`

Example:

```json
{
  "plugins": {
    "entries": {
      "memory-core": {
        "config": {
          "dreaming": {
            "mode": "core"
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
- Dreaming cadence defaults to each mode's preset schedule. Override cadence with `plugins.entries.memory-core.config.dreaming.frequency` as a cron expression (for example `0 3 * * *`) and fine-tune with `timezone`, `limit`, `minScore`, `minRecallCount`, and `minUniqueQueries`.
