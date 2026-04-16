# Memory v2 (foundation)

An additive, default-off sidecar that records per-memory metadata (source, location, status, pinning, salience, last-accessed time) alongside the existing memory index, plus an opt-in rerank pass for `memory_search` results.

Everything described here is **off by default**. Nothing in this foundation changes agent behavior until you explicitly enable a flag. When flags are off, the sidecar database is not opened and no extra code runs on the hot path.

## What ships today

- A SQLite sidecar at `memory/v2-sidecar.db` (per workspace) that stores one row per memory-v2 record, with its schema managed in-tree.
- An ingest pipeline wired to `agent_end` that writes sidecar rows for successful agent turns when ingest is enabled.
- A rerank wrapper wired into `memory_search` that reorders results using salience, recency, pinning, and supersession signals when rerank is enabled.
- An optional shadow-touch path that updates `last_accessed_at` for memory-v2 hits returned by search (useful later for recency scoring).
- An `openclaw memory sidecar` CLI: `stats` and `list` inspect the sidecar (read-only); `pin` flips the `pinned` flag on a record by its full ref id.

**Not shipped:** salience writes, supersession writes, status mutation, ref-id prefix matching, dreaming-phase integration, and any form of automatic promotion or demotion. A future change adds each of these surfaces explicitly.

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

| Flag                                  | Type    | Default        | Bounds  | Effect                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ------- | -------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memoryV2.rerank.enabled`             | boolean | `false`        | —       | Enable the rerank pass for `memory_search` results. When off, the pass returns its input verbatim.                                                                                                                                                                         |
| `memoryV2.rerank.shadowOnRecall`      | boolean | `false`        | —       | Also update `last_accessed_at` for memory-v2 hits returned by search. Works independently of `enabled`: with `enabled: false`, search order is unchanged and only recency touches are recorded ("shadow-only mode"). Non-memory-v2 hits are filtered out before any write. |
| `memoryV2.rerank.salienceWeight`      | number  | module default | `0`–`2` | Weight applied to stored salience.                                                                                                                                                                                                                                         |
| `memoryV2.rerank.recencyHalfLifeDays` | number  | module default | `≥ 0`   | Exponential half-life for recency decay.                                                                                                                                                                                                                                   |
| `memoryV2.rerank.pinnedBoost`         | number  | module default | `0`–`5` | Additive boost for pinned rows.                                                                                                                                                                                                                                            |
| `memoryV2.rerank.supersededPenalty`   | number  | module default | `0`–`1` | Multiplicative penalty for superseded rows.                                                                                                                                                                                                                                |

If the rerank wrapper throws at runtime it falls back to identity (returning the input list unchanged) rather than surfacing an error to the search path.

## Sidecar CLI

`openclaw memory sidecar` inspects and lightly curates the sidecar database for the default agent (or the agent passed with `--agent`). `stats` and `list` are strictly read-only. `pin` is the only write and touches only the `pinned` flag of an existing row — no inserts, no other column writes.

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

### `memory sidecar pin`

Flip the `pinned` flag on an existing sidecar record. Requires the **full** ref id — no prefix matching in this slice. Get a full ref id from `memory sidecar list --json` (the human-readable list truncates to the first 8 characters for display).

```
openclaw memory sidecar pin <ref-id>
openclaw memory sidecar pin <ref-id> --unpin
openclaw memory sidecar pin <ref-id> --agent my-agent
openclaw memory sidecar pin <ref-id> --json
```

| Option         | Description                                                                          |
| -------------- | ------------------------------------------------------------------------------------ |
| `<ref-id>`     | Required positional. Full sidecar ref id. Unknown ids report "ref-id not found".     |
| `--unpin`      | Clear the pinned flag instead of setting it.                                         |
| `--agent <id>` | Target a specific agent's sidecar (default: default agent).                          |
| `--json`       | Emit JSON (`[{ agentId, dbPath, initialized, outcome: { refId, found, pinned } }]`). |
| `--verbose`    | Verbose logging for diagnostics.                                                     |

The command is scoped and safe: it updates `pinned` and nothing else, touches one row at most per agent, and fails the operation quietly (reports `ref-id not found`) rather than inserting placeholder rows when the id is unknown. The rerank `pinnedBoost` weight already reads this flag (see the rerank table above), so pinning takes effect the next time the rerank pass runs.

If the sidecar database has not been initialized yet (for example, because `memoryV2.ingest.enabled` has never been on in this workspace), all three subcommands print a "sidecar not initialized" notice and exit without error.

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
5. **(Optional) Collect recency signal without reordering (shadow-only mode):** set `memoryV2.rerank.shadowOnRecall: true` with `memoryV2.rerank.enabled: false`. Search order is unchanged; the wrapper only records `last_accessed_at` for memory-v2 hits. Re-run `memory sidecar stats` after a few searches and confirm `last accessed` advances. If you additionally set `memoryV2.rerank.enabled: true`, `memory_search` results also go through the rerank pass; if anything in that pass throws, search silently falls back to the original order.

Every step is reversible: turn any flag off and the corresponding path is no longer taken on subsequent runs. The sidecar file remains on disk but is no longer written to.
