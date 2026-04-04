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

## Modes

`dreaming.mode` controls cadence and default thresholds:

- `off`: dreaming disabled.
- `core`: nightly cadence with balanced thresholds.
- `rem`: more frequent cadence for active consolidation.
- `deep`: stricter promotion gating with slower cadence.

Default presets:

- `core`: `0 3 * * *`, `minScore=0.75`, `minRecallCount=3`,
  `minUniqueQueries=2`
- `rem`: `0 */6 * * *`, `minScore=0.85`, `minRecallCount=4`,
  `minUniqueQueries=3`
- `deep`: `0 */12 * * *`, `minScore=0.8`, `minRecallCount=3`,
  `minUniqueQueries=3`

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

## Operational notes

- Use `/dreaming off|core|rem|deep` to switch modes from chat.
- Use `openclaw memory promote` to preview candidates and
  `openclaw memory promote --apply` for manual promotion.
- Use `openclaw memory status --deep` to inspect current memory and dreaming
  status.

## Further reading

- [Memory](/concepts/memory)
- [Memory Search](/concepts/memory-search)
- [memory CLI](/cli/memory)
- [Memory configuration reference](/reference/memory-config)
