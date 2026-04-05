---
title: "Dreaming (experimental)"
summary: "Background promotion from short-term recall into long-term memory"
read_when:
  - You want memory promotion to run automatically
  - You want to understand dreaming modes and thresholds
  - You want to tune consolidation without polluting MEMORY.md
---

# Dreaming (experimental)

Dreaming is the background memory consolidation pass in `memory-core`.

It is called "dreaming" because the system revisits what came up during the day
and decides what is worth keeping as durable context.

Dreaming is **experimental**, **opt-in**, and **off by default**.

## What dreaming does

1. Tracks short-term recall events from `memory_search` hits in
   `memory/YYYY-MM-DD.md`.
2. Scores those recall candidates with weighted signals.
3. Promotes only qualified candidates into `MEMORY.md`.

This keeps long-term memory focused on durable, repeated context instead of
one-off details.

## Promotion signals

Dreaming combines six signals:

- **Frequency**: how often the same candidate was recalled.
- **Relevance**: how strong recall scores were when it was retrieved.
- **Query diversity**: how many distinct query intents surfaced it.
- **Recency**: temporal weighting over recent recalls.
- **Consolidation**: whether recalls repeated across distinct days instead of one burst.
- **Conceptual richness**: derived concept tags from the note path and snippet text.

Promotion requires all configured threshold gates to pass, not just one signal.

### Signal weights

| Signal              | Weight | Description                                        |
| ------------------- | ------ | -------------------------------------------------- |
| Frequency           | 0.24   | How often the same entry was recalled              |
| Relevance           | 0.30   | Average recall scores when retrieved               |
| Query diversity     | 0.15   | Count of distinct query intents that surfaced it   |
| Recency             | 0.15   | Temporal decay (`recencyHalfLifeDays`, default 14) |
| Consolidation       | 0.10   | Reward recalls repeated across multiple days       |
| Conceptual richness | 0.06   | Reward entries with richer derived concept tags    |

## How it works

1. **Recall tracking** -- Every `memory_search` hit is recorded to
   `memory/.dreams/short-term-recall.json` with recall count, scores, query
   hash, recall days, and concept tags.
2. **Scheduled scoring** -- On the configured cadence, candidates are ranked
   using weighted signals. All threshold gates must pass simultaneously.
3. **Workspace fan-out** -- Each dreaming cycle runs once per configured memory
   workspace, so one agent's sessions consolidate into that agent's memory
   workspace.
4. **Promotion** -- Before appending anything, dreaming re-reads the current
   daily note and skips candidates whose source snippet no longer exists.
   Qualifying live entries are appended to `MEMORY.md` with a promoted
   timestamp.
5. **Cleanup** -- Already-promoted entries are filtered from future cycles. A
   file lock prevents concurrent runs.

## Modes

`dreaming.mode` controls cadence and default thresholds:

| Mode   | Cadence        | minScore | minRecallCount | minUniqueQueries | recencyHalfLifeDays |
| ------ | -------------- | -------- | -------------- | ---------------- | ------------------- |
| `off`  | Disabled       | --       | --             | --               | --                  |
| `core` | Daily 3 AM     | 0.75     | 3              | 2                | 14                  |
| `rem`  | Every 6 hours  | 0.85     | 4              | 3                | 14                  |
| `deep` | Every 12 hours | 0.80     | 3              | 3                | 14                  |

## Scheduling model

When dreaming is enabled, `memory-core` manages the recurring schedule
automatically. You do not need to manually create a cron job for this feature.

You can still tune behavior with explicit overrides such as:

- `dreaming.cron` (cron expression)
- `dreaming.timezone`
- `dreaming.limit`
- `dreaming.minScore`
- `dreaming.minRecallCount`
- `dreaming.minUniqueQueries`
- `dreaming.recencyHalfLifeDays`
- `dreaming.maxAgeDays`
- `dreaming.verboseLogging`

## Configure

```json
{
  "plugins": {
    "entries": {
      "memory-core": {
        "config": {
          "dreaming": {
            "mode": "core",
            "recencyHalfLifeDays": 21,
            "maxAgeDays": 30
          }
        }
      }
    }
  }
}
```

## Chat commands

Switch modes and check status from chat:

```
/dreaming core          # Switch to core mode (nightly)
/dreaming rem           # Switch to rem mode (every 6h)
/dreaming deep          # Switch to deep mode (every 12h)
/dreaming off           # Disable dreaming
/dreaming status        # Show current config and cadence
/dreaming help          # Show mode guide
```

## CLI commands

Preview and apply promotions from the command line:

```bash
# Preview promotion candidates
openclaw memory promote

# Apply promotions to MEMORY.md
openclaw memory promote --apply

# Limit preview count
openclaw memory promote --limit 5

# Include already-promoted entries
openclaw memory promote --include-promoted

# Manual runs inherit dreaming thresholds unless you override them
openclaw memory promote --apply

# Check dreaming status
openclaw memory status --deep
```

See [memory CLI](/cli/memory) for the full flag reference.

## Dreams UI

When dreaming is enabled, the Gateway sidebar shows a **Dreams** tab with
memory stats (short-term count, long-term count, promoted count) and the next
scheduled cycle time. Daily counters honor `dreaming.timezone` when set and
otherwise fall back to the configured user timezone.

Manual `openclaw memory promote` runs use the same dreaming thresholds by
default, so scheduled and on-demand promotion stay aligned unless you pass CLI
overrides.

## Further reading

- [Memory](/concepts/memory)
- [Memory Search](/concepts/memory-search)
- [memory CLI](/cli/memory)
- [Memory configuration reference](/reference/memory-config)
