# Memory v2 (foundation)

An additive, default-off sidecar that records per-memory metadata (source, location, status, pinning, salience, last-accessed time) alongside the existing memory index, plus an opt-in rerank pass for `memory_search` results.

Everything described here is **off by default**. Nothing in this foundation changes agent behavior until you explicitly enable a flag. When flags are off, the sidecar database is not opened and no extra code runs on the hot path.

## What ships today

- A SQLite sidecar at `memory/v2-sidecar.db` (per workspace) that stores one row per memory-v2 record, with its schema managed in-tree.
- An ingest pipeline wired to `agent_end` that writes sidecar rows for successful agent turns when ingest is enabled.
- A rerank wrapper wired into `memory_search` that reorders results using salience, recency, pinning, and supersession signals when rerank is enabled.
- An optional shadow-touch path that updates `last_accessed_at` for memory-v2 hits returned by search (useful later for recency scoring).
- A read-only CLI (`openclaw memory sidecar`) for inspecting the sidecar.

**Not shipped:** pinning or salience writes, supersession writes, status mutation, dreaming-phase integration, and any form of automatic promotion or demotion. The foundation is observation-only until a future change adds those surfaces explicitly.

## Opt-in configuration

All flags live under `plugins.entries.memory-core.config.memoryV2.*`. The schema is declared in `extensions/memory-core/openclaw.plugin.json` and is validated at config load.

### Ingest

```json5
{
  plugins: {
    entries: {
      "memory-core": {
        config: {
          memoryV2: {
            ingest: { enabled: true },
          },
        },
      },
    },
  },
}
```

| Flag                      | Type    | Default | Effect                                                                       |
| ------------------------- | ------- | ------- | ---------------------------------------------------------------------------- |
| `memoryV2.ingest.enabled` | boolean | `false` | Register the `agent_end` hook that writes sidecar rows for successful turns. |

Ingest only fires on `agent_end` with `success: true` and a known `workspaceDir` and `sessionId`. Failures inside ingest are caught and logged at warn level; ingest never throws out of the hook.

### Rerank

```json5
{
  plugins: {
    entries: {
      "memory-core": {
        config: {
          memoryV2: {
            rerank: {
              enabled: true,
              shadowOnRecall: true,
              // Optional weights (defaults live in the rerank module):
              salienceWeight: 0.5,
              recencyHalfLifeDays: 14,
              pinnedBoost: 1.0,
              supersededPenalty: 0.5,
            },
          },
        },
      },
    },
  },
}
```

| Flag                                  | Type    | Default        | Bounds  | Effect                                                                                                                                          |
| ------------------------------------- | ------- | -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `memoryV2.rerank.enabled`             | boolean | `false`        | —       | Enable the rerank pass for `memory_search` results. When off, the pass returns its input verbatim.                                              |
| `memoryV2.rerank.shadowOnRecall`      | boolean | `false`        | —       | While rerank is on, also update `last_accessed_at` for memory-v2 hits returned by search. Non-memory-v2 hits are filtered out before any write. |
| `memoryV2.rerank.salienceWeight`      | number  | module default | `0`–`2` | Weight applied to stored salience.                                                                                                              |
| `memoryV2.rerank.recencyHalfLifeDays` | number  | module default | `≥ 0`   | Exponential half-life for recency decay.                                                                                                        |
| `memoryV2.rerank.pinnedBoost`         | number  | module default | `0`–`5` | Additive boost for pinned rows.                                                                                                                 |
| `memoryV2.rerank.supersededPenalty`   | number  | module default | `0`–`1` | Multiplicative penalty for superseded rows.                                                                                                     |

If the rerank wrapper throws at runtime it falls back to identity (returning the input list unchanged) rather than surfacing an error to the search path.

## Read-only sidecar CLI

`openclaw memory sidecar` inspects the sidecar database for the default agent (or the agent passed with `--agent`). Both subcommands are read-only; neither writes to the sidecar.

### `memory sidecar stats`

Row counts by status and source, pinned count, schema version, and the oldest/newest timestamps.

```
openclaw memory sidecar stats
openclaw memory sidecar stats --agent my-agent
openclaw memory sidecar stats --json
```

### `memory sidecar list`

Sidecar rows newest-first, one per line.

```
openclaw memory sidecar list
openclaw memory sidecar list --limit 50
openclaw memory sidecar list --status active
openclaw memory sidecar list --json
```

| Option         | Description                                                         |
| -------------- | ------------------------------------------------------------------- |
| `--agent <id>` | Inspect a specific agent's sidecar (default: default agent).        |
| `--status <s>` | Filter by status: `active`, `superseded`, `archived`, or `deleted`. |
| `--limit <n>`  | Row cap. Default `20`, max `1000`.                                  |
| `--json`       | Emit JSON instead of the human table.                               |
| `--verbose`    | Verbose logging for diagnostics.                                    |

If the sidecar database has not been initialized yet (for example, because `memoryV2.ingest.enabled` has never been on in this workspace), both commands print a "sidecar not initialized" notice and exit without error.

## Verification flow

To confirm Memory v2 is wired up correctly in your workspace:

1. **Flip ingest on** by setting `memoryV2.ingest.enabled: true` in the memory-core plugin config and reloading.
2. **Run the agent normally** for a few turns so `agent_end` fires on successful sessions.
3. **Check the sidecar**:
   ```
   openclaw memory sidecar stats
   ```
   You should see `total rows > 0`, `schema version` populated, and a breakdown under `by source`.
4. **Sample recent rows**:
   ```
   openclaw memory sidecar list --limit 5
   ```
   Each row shows the ref id prefix, source, file location, status, pin flag, salience, and creation time.
5. **(Optional) Try rerank in a safe way**: set `memoryV2.rerank.enabled: true`. `memory_search` now goes through the rerank wrapper; if anything in the wrapper throws, search silently falls back to the original order. To additionally record recency touches on hits, also set `memoryV2.rerank.shadowOnRecall: true`, then re-run `memory sidecar stats` after a few searches and confirm `last accessed` advances.

Every step is reversible: turn any flag off and the corresponding path is no longer taken on subsequent runs. The sidecar file remains on disk but is no longer written to.
