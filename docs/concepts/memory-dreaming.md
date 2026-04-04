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

Dreaming combines four signals:

- **Frequency**: how often the same candidate was recalled.
- **Relevance**: how strong recall scores were when it was retrieved.
- **Query diversity**: how many distinct query intents surfaced it.
- **Recency**: temporal weighting over recent recalls.

Promotion requires all configured threshold gates to pass, not just one signal.

### Signal weights

| Signal    | Weight | Description                                        |
| --------- | ------ | -------------------------------------------------- |
| Frequency | 0.35   | How often the same entry was recalled              |
| Relevance | 0.35   | Average recall scores when retrieved               |
| Diversity | 0.15   | Count of distinct query intents that surfaced it   |
| Recency   | 0.15   | Temporal decay (14-day half-life)                  |

## How it works

1. **Recall tracking** -- Every `memory_search` hit is recorded to
   `memory/.dreams/short-term-recall.json` with recall count, scores, and query
   hash.
2. **Scheduled scoring** -- On the configured cadence, candidates are ranked
   using weighted signals. All threshold gates must pass simultaneously.
3. **Promotion** -- Qualifying entries are appended to `MEMORY.md` with a
   promoted timestamp.
4. **Cleanup** -- Already-promoted entries are filtered from future cycles. A
   file lock prevents concurrent runs.

## Modes

`dreaming.mode` controls cadence and default thresholds:

| Mode   | Cadence       | minScore | minRecallCount | minUniqueQueries |
| ------ | ------------- | -------- | -------------- | ---------------- |
| `off`  | Disabled      | --       | --             | --               |
| `core` | Daily 3 AM    | 0.75     | 3              | 2                |
| `rem`  | Every 6 hours | 0.85     | 4              | 3                |
| `deep` | Every 12 hours | 0.80    | 3              | 3                |

## Scheduling model

When dreaming is enabled, `memory-core` manages the recurring schedule
automatically. You do not need to manually create a cron job for this feature.

You can still tune behavior with explicit overrides such as:

- `dreaming.frequency` (cron expression)
- `dreaming.timezone`
- `dreaming.limit`
- `dreaming.minScore`
- `dreaming.minRecallCount`
- `dreaming.minUniqueQueries`

## Configure

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

# Check dreaming status
openclaw memory status --deep
```

See [memory CLI](/cli/memory) for the full flag reference.

## Dreams UI

When dreaming is enabled, the Gateway sidebar shows a **Dreams** tab with
memory stats (short-term count, long-term count, promoted count) and the next
scheduled cycle time.

## Further reading

- [Memory](/concepts/memory)
- [Memory Search](/concepts/memory-search)
- [memory CLI](/cli/memory)
- [Memory configuration reference](/reference/memory-config)
