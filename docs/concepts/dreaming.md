---
title: "Dreaming (experimental)"
summary: "Background memory consolidation with three cooperative phases: light, deep, and REM"
read_when:
  - You want memory promotion to run automatically
  - You want to understand the three dreaming phases
  - You want to tune consolidation without polluting MEMORY.md
---

# Dreaming (experimental)

Dreaming is the background memory consolidation system in `memory-core`. It
revisits what came up during conversations and decides what is worth keeping as
durable context.

Dreaming uses three cooperative **phases**, not competing modes. Each phase has
a distinct job, writes to a distinct target, and runs on its own schedule.

## The three phases

### Light

Light dreaming sorts the recent mess. It scans recent memory traces, dedupes
them by Jaccard similarity, clusters related entries, and stages candidate
memories into the shared dreaming trail file (`DREAMS.md`) when inline storage
is enabled.

Light does **not** write anything into `MEMORY.md`. It only organizes and
stages. Think: "what from today might matter later?"

### Deep

Deep dreaming decides what becomes durable memory. It runs the real promotion
logic: weighted scoring across six signals, threshold gates, recall count,
unique query diversity, recency decay, and max age filtering.

Deep is the **only** phase allowed to write durable facts into `MEMORY.md`.
It also owns recovery when memory is thin (health drops below a configured
threshold). Think: "what is true enough to keep?"

### REM

REM dreaming looks for patterns and reflection. It examines recent material,
identifies recurring themes through concept tag clustering, and writes
higher-order notes and reflections into `DREAMS.md` when inline storage is
enabled.

REM writes to `DREAMS.md` in inline mode, **not** `MEMORY.md`.
Its output is interpretive, not canonical. Think: "what pattern am I noticing?"

## Hard boundaries

| Phase | Job       | Writes to                 | Does NOT write to |
| ----- | --------- | ------------------------- | ----------------- |
| Light | Organize  | `DREAMS.md` (inline mode) | MEMORY.md         |
| Deep  | Preserve  | MEMORY.md                 | --                |
| REM   | Interpret | `DREAMS.md` (inline mode) | MEMORY.md         |

## Quick start

Enable all three phases (recommended):

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

Enable only deep promotion:

```json
{
  "plugins": {
    "entries": {
      "memory-core": {
        "config": {
          "dreaming": {
            "enabled": true,
            "phases": {
              "light": { "enabled": false },
              "deep": { "enabled": true },
              "rem": { "enabled": false }
            }
          }
        }
      }
    }
  }
}
```

## Configuration

All dreaming settings live under `plugins.entries.memory-core.config.dreaming`
in `openclaw.json`. See [Memory configuration reference](/reference/memory-config#dreaming-experimental)
for the full key list.

### Global settings

| Key              | Type      | Default    | Description                                                  |
| ---------------- | --------- | ---------- | ------------------------------------------------------------ |
| `enabled`        | `boolean` | `true`     | Master switch for all phases                                 |
| `timezone`       | `string`  | unset      | Timezone for schedule evaluation and dreaming date bucketing |
| `verboseLogging` | `boolean` | `false`    | Emit detailed per-run dreaming logs                          |
| `storage.mode`   | `string`  | `"inline"` | Inline `DREAMS.md`, separate reports, or both                |

### Light phase config

| Key                | Type       | Default                         | Description                       |
| ------------------ | ---------- | ------------------------------- | --------------------------------- |
| `enabled`          | `boolean`  | `true`                          | Enable light phase                |
| `cron`             | `string`   | `0 */6 * * *`                   | Schedule (default: every 6 hours) |
| `lookbackDays`     | `number`   | `2`                             | How many days of traces to scan   |
| `limit`            | `number`   | `100`                           | Max candidates to stage per run   |
| `dedupeSimilarity` | `number`   | `0.9`                           | Jaccard threshold for dedup       |
| `sources`          | `string[]` | `["daily","sessions","recall"]` | Data sources to scan              |

### Deep phase config

| Key                   | Type       | Default                                         | Description                          |
| --------------------- | ---------- | ----------------------------------------------- | ------------------------------------ |
| `enabled`             | `boolean`  | `true`                                          | Enable deep phase                    |
| `cron`                | `string`   | `0 3 * * *`                                     | Schedule (default: daily at 3 AM)    |
| `limit`               | `number`   | `10`                                            | Max candidates to promote per cycle  |
| `minScore`            | `number`   | `0.8`                                           | Minimum weighted score for promotion |
| `minRecallCount`      | `number`   | `3`                                             | Minimum recall count threshold       |
| `minUniqueQueries`    | `number`   | `3`                                             | Minimum distinct query count         |
| `recencyHalfLifeDays` | `number`   | `14`                                            | Days for recency score to halve      |
| `maxAgeDays`          | `number`   | `30`                                            | Max daily-note age for promotion     |
| `sources`             | `string[]` | `["daily","memory","sessions","logs","recall"]` | Data sources                         |

### Deep recovery config

Recovery kicks in when long-term memory health drops below a threshold.

| Key                               | Type      | Default | Description                                |
| --------------------------------- | --------- | ------- | ------------------------------------------ |
| `recovery.enabled`                | `boolean` | `true`  | Enable automatic recovery                  |
| `recovery.triggerBelowHealth`     | `number`  | `0.35`  | Health score threshold to trigger recovery |
| `recovery.lookbackDays`           | `number`  | `30`    | How far back to look for recovery material |
| `recovery.maxRecoveredCandidates` | `number`  | `20`    | Max candidates to recover per run          |
| `recovery.minRecoveryConfidence`  | `number`  | `0.9`   | Minimum confidence for recovery candidates |
| `recovery.autoWriteMinConfidence` | `number`  | `0.97`  | Auto-write threshold (skip manual review)  |

### REM phase config

| Key                  | Type       | Default                     | Description                             |
| -------------------- | ---------- | --------------------------- | --------------------------------------- |
| `enabled`            | `boolean`  | `true`                      | Enable REM phase                        |
| `cron`               | `string`   | `0 5 * * 0`                 | Schedule (default: weekly, Sunday 5 AM) |
| `lookbackDays`       | `number`   | `7`                         | How many days of material to reflect on |
| `limit`              | `number`   | `10`                        | Max patterns or themes to write         |
| `minPatternStrength` | `number`   | `0.75`                      | Minimum tag co-occurrence strength      |
| `sources`            | `string[]` | `["memory","daily","deep"]` | Data sources for reflection             |

### Execution overrides

Each phase accepts an `execution` block to override global defaults:

| Key               | Type     | Default      | Description                    |
| ----------------- | -------- | ------------ | ------------------------------ |
| `speed`           | `string` | `"balanced"` | `fast`, `balanced`, or `slow`  |
| `thinking`        | `string` | `"medium"`   | `low`, `medium`, or `high`     |
| `budget`          | `string` | `"medium"`   | `cheap`, `medium`, `expensive` |
| `model`           | `string` | unset        | Override model for this phase  |
| `maxOutputTokens` | `number` | unset        | Cap output tokens              |
| `temperature`     | `number` | unset        | Sampling temperature (0-2)     |
| `timeoutMs`       | `number` | unset        | Phase timeout in milliseconds  |

## Promotion signals (deep phase)

Deep dreaming combines six weighted signals. Promotion requires all configured
threshold gates to pass simultaneously.

| Signal              | Weight | Description                                        |
| ------------------- | ------ | -------------------------------------------------- |
| Frequency           | 0.24   | How often the same entry was recalled              |
| Relevance           | 0.30   | Average recall scores when retrieved               |
| Query diversity     | 0.15   | Count of distinct query intents that surfaced it   |
| Recency             | 0.15   | Temporal decay (`recencyHalfLifeDays`, default 14) |
| Consolidation       | 0.10   | Reward recalls repeated across multiple days       |
| Conceptual richness | 0.06   | Reward entries with richer derived concept tags    |

## Chat commands

```
/dreaming status                 # Show phase config and cadence
/dreaming on                     # Enable all phases
/dreaming off                    # Disable all phases
/dreaming enable light|deep|rem  # Enable a specific phase
/dreaming disable light|deep|rem # Disable a specific phase
/dreaming help                   # Show usage guide
```

## CLI commands

Preview and apply deep promotions from the command line:

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

### Preview and explain tools

Two additional subcommands help you inspect promotion and REM behavior without writing anything:

```bash
# Explain why a candidate would or would not promote
openclaw memory promote-explain "meeting notes"

# Preview REM reflections, candidate truths, and deep promotions
openclaw memory rem-harness --json
```

See [memory CLI](/cli/memory) for full options.

## How it works

### Light phase pipeline

1. Read short-term recall entries from `memory/.dreams/short-term-recall.json`.
2. Filter entries within `lookbackDays` of the current time.
3. Deduplicate by Jaccard similarity (configurable threshold).
4. Sort by average recall score, take up to `limit` entries.
5. Write staged candidates into `DREAMS.md` under a `## Light Sleep` block when
   inline storage is enabled.

### Deep phase pipeline

1. Read and rank short-term recall candidates using weighted signals.
2. Apply threshold gates: `minScore`, `minRecallCount`, `minUniqueQueries`.
3. Filter by `maxAgeDays` and apply recency decay.
4. Fan out across configured memory workspaces.
5. Re-read the live daily note before writing (skip stale or deleted snippets).
6. Append qualifying entries to `MEMORY.md` with promoted timestamps.
7. Mark promoted entries to exclude them from future cycles.
8. If health is below `recovery.triggerBelowHealth`, run the recovery pass.

### REM phase pipeline

1. Read recent memory traces within `lookbackDays`.
2. Cluster concept tags by co-occurrence.
3. Filter patterns by `minPatternStrength`.
4. Write themes and reflections into `DREAMS.md` under a `## REM Sleep` block
   when inline storage is enabled.

## Scheduling

Each phase manages its own cron job automatically. When dreaming is enabled,
`memory-core` reconciles managed cron jobs on gateway startup. You do not need
to manually create cron entries.

| Phase | Default schedule | Description         |
| ----- | ---------------- | ------------------- |
| Light | `0 */6 * * *`    | Every 6 hours       |
| Deep  | `0 3 * * *`      | Daily at 3 AM       |
| REM   | `0 5 * * 0`      | Weekly, Sunday 5 AM |

Override any schedule with the phase `cron` key. All schedules honor the global
`timezone` setting.

## Dreams UI

When dreaming is enabled, the Gateway sidebar shows a **Dreams** tab with
memory stats (short-term count, long-term count, promoted count) and the next
scheduled cycle time. Daily counters honor `dreaming.timezone` when set and
otherwise fall back to the configured user timezone.

Manual `openclaw memory promote` runs use the same deep phase thresholds by
default, so scheduled and on-demand promotion stay aligned unless you pass CLI
overrides.

## Related

- [Memory](/concepts/memory)
- [Memory Search](/concepts/memory-search)
- [Memory configuration reference](/reference/memory-config)
- [memory CLI](/cli/memory)
