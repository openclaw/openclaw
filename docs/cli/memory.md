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
```

## Options

`memory status` and `memory index`:

- `--agent <id>`: scope to a single agent. Without it, these commands run for each configured agent; if no agent list is configured, they fall back to the default agent.
- `--verbose`: emit detailed logs during probes and indexing.

`memory status`:

- `--deep`: probe vector + embedding availability.
- `--index`: run a reindex if the store is dirty (implies `--deep`).
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

- Ranks short-term candidates from `memory/YYYY-MM-DD.md` using weighted recall signals (`frequency`, `relevance`, `query diversity`, `recency`).
- Uses recall events captured when `memory_search` returns daily-memory hits.
- Optional auto-dreaming mode: when `plugins.entries.memory-core.config.shortTermPromotion.dreaming.enabled=true`, `memory-core` auto-manages a nightly cron job that triggers promotion in the background (no manual `openclaw cron add` required).
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
- Enable it with `plugins.entries.memory-core.config.shortTermPromotion.dreaming.enabled=true`.
- When enabled, `memory-core` automatically creates and maintains a managed nightly cron job.
- Ranking uses weighted signals: recall frequency, retrieval relevance, query diversity, and temporal recency (recent recalls decay over time).
- Promotion into `MEMORY.md` only happens when quality thresholds are met, so long-term memory stays high signal instead of collecting one-off details.

Default promotion thresholds:

- `minScore=0.75`
- `minRecallCount=3`
- `minUniqueQueries=2`

Example:

```json
{
  "plugins": {
    "entries": {
      "memory-core": {
        "config": {
          "shortTermPromotion": {
            "dreaming": {
              "enabled": true
            }
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
- Dreaming schedule defaults to `0 3 * * *`; override with `plugins.entries.memory-core.config.shortTermPromotion.dreaming.cron`, `timezone`, `limit`, `minScore`, `minRecallCount`, and `minUniqueQueries`.
