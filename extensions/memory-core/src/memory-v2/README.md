# Memory v2 (foundation)

An additive, default-off sidecar that records per-memory metadata (source, location, status, pinning, salience, last-accessed time) alongside the existing memory index, plus an opt-in rerank pass for `memory_search` results.

Everything described here is **off by default**. Nothing in this foundation changes agent behavior until you explicitly enable a flag. When flags are off, the sidecar database is not opened and no extra code runs on the hot path.

## What ships today

- A SQLite sidecar at `memory/v2-sidecar.db` (per workspace) that stores one row per memory-v2 record, with its schema managed in-tree.
- An ingest pipeline wired to `agent_end` that writes sidecar rows for successful agent turns when ingest is enabled.
- A rerank wrapper wired into `memory_search` that reorders results using salience, recency, pinning, and supersession signals when rerank is enabled.
- An optional shadow-touch path that updates `last_accessed_at` for memory-v2 hits returned by search (useful later for recency scoring).
- An `openclaw memory sidecar` CLI: `stats` and `list` inspect the sidecar (read-only); `pin`, `status`, `salience`, and `supersede` each touch exactly one column of an existing record, addressed by the full ref id or a unique ref-id prefix, covering every input the rerank pass reads (`pinnedBoost`, `supersededPenalty`, `salienceWeight`) plus the `superseded_by` link that records _what_ superseded a row.

**Not shipped:** dreaming-phase integration, backfill of pre-existing memory data into the sidecar, and any form of automatic promotion or demotion. A future change adds each of these surfaces explicitly.

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

`openclaw memory sidecar` inspects and lightly curates the sidecar database for the default agent (or the agent passed with `--agent`). `stats` and `list` are strictly read-only. `pin`, `status`, `salience`, and `supersede` are the only writes, and each touches exactly one column of an existing row — no inserts, no other column writes. No writer cross-touches another writer's column (for example, `supersede` does not flip `status` to `superseded`; run both commands if you want both effects).

### Ref-id resolution

`pin`, `status`, `salience`, and both positionals of `supersede` all accept either a full sidecar ref id or a unique **prefix** of one. Resolution runs once per agent against that agent's own sidecar and is shared by every writer:

- **Exact match** always wins — a full ref id continues to round-trip identically, even if it happens to be a prefix of a longer id.
- **Unique prefix** resolves to the single matching full ref id and the write proceeds against it.
- **Ambiguous prefix** (2+ matches) prints the first few candidates and does **not** mutate anything. A longer prefix disambiguates. The candidate list is capped (5 by default); if there were more matches than were shown, a `… and more` hint appears so operators know to narrow further.
- **No match** prints `ref-id not found: <input>` and does **not** mutate anything.

Empty / whitespace-only input is treated as a miss rather than a wildcard. LIKE metacharacters (`%`, `_`, `\`) in the input are escaped so a ref id containing them literally cannot accidentally widen the search.

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

Flip the `pinned` flag on an existing sidecar record. `<ref-id>` is the full sidecar ref id or a unique prefix (see "Ref-id resolution" below). The human-readable `list` output truncates ref ids to 8 characters for display; the 8-character prefix is usually unique and is the expected shape operators copy-paste back into `pin`.

```
openclaw memory sidecar pin <ref-id>
openclaw memory sidecar pin <ref-id> --unpin
openclaw memory sidecar pin <ref-id> --agent my-agent
openclaw memory sidecar pin <ref-id> --json
```

| Option         | Description                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<ref-id>`     | Required positional. Full sidecar ref id or unique prefix; ambiguous or missing ids are rejected.                                                                         |
| `--unpin`      | Clear the pinned flag instead of setting it.                                                                                                                              |
| `--agent <id>` | Target a specific agent's sidecar (default: default agent).                                                                                                               |
| `--json`       | Emit JSON (`[{ agentId, dbPath, initialized, resolution, outcome }]`; see "Ref-id resolution" above; `outcome` is `{ refId, found, pinned }` on match, `null` otherwise). |
| `--verbose`    | Verbose logging for diagnostics.                                                                                                                                          |

The command is scoped and safe: it updates `pinned` and nothing else, touches one row at most per agent, and fails the operation quietly (reports `ref-id not found`) rather than inserting placeholder rows when the id is unknown. The rerank `pinnedBoost` weight already reads this flag (see the rerank table above), so pinning takes effect the next time the rerank pass runs.

### `memory sidecar status`

Set the lifecycle `status` of an existing sidecar record. Accepts exactly `active`, `superseded`, `archived`, or `deleted` (case-sensitive). `<ref-id>` is the full sidecar ref id or a unique prefix (see "Ref-id resolution" below).

```
openclaw memory sidecar status <ref-id> active
openclaw memory sidecar status <ref-id> superseded
openclaw memory sidecar status <ref-id> archived --agent my-agent
openclaw memory sidecar status <ref-id> deleted --json
```

| Option         | Description                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<ref-id>`     | Required positional. Full sidecar ref id or unique prefix; ambiguous or missing ids are rejected.                                                                         |
| `<status>`     | Required positional. One of `active`, `superseded`, `archived`, `deleted`.                                                                                                |
| `--agent <id>` | Target a specific agent's sidecar (default: default agent).                                                                                                               |
| `--json`       | Emit JSON (`[{ agentId, dbPath, initialized, resolution, outcome }]`; see "Ref-id resolution" above; `outcome` is `{ refId, found, status }` on match, `null` otherwise). |
| `--verbose`    | Verbose logging for diagnostics.                                                                                                                                          |

Invalid `<status>` values are rejected before any database work with a single-line `invalid status …` warning. **No transition gating:** any source status can be written to any target status, including `deleted → active`. The command mirrors the behavior of the underlying `markStatus` primitive. Operators who need transition rules should enforce them externally. The rerank `supersededPenalty` weight already reads this column (see the rerank table above), so flipping to `superseded` takes effect the next time the rerank pass runs.

### `memory sidecar salience`

Set or clear the salience of an existing sidecar record. `<value>` is either a finite number (positive, negative, or zero) or the literal sentinel `clear`. **`0` and `clear` are distinct**: `0` is a recorded zero-salience value; `clear` writes SQL `NULL` (never set). `<ref-id>` is the full sidecar ref id or a unique prefix (see "Ref-id resolution" below).

```
openclaw memory sidecar salience <ref-id> 0.7
openclaw memory sidecar salience <ref-id> -0.25
openclaw memory sidecar salience <ref-id> 0
openclaw memory sidecar salience <ref-id> clear
openclaw memory sidecar salience <ref-id> 0.5 --agent my-agent
openclaw memory sidecar salience <ref-id> 0.5 --json
```

| Option         | Description                                                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<ref-id>`     | Required positional. Full sidecar ref id or unique prefix; ambiguous or missing ids are rejected.                                                                           |
| `<value>`      | Required positional. A finite number, or the literal `clear` to write `NULL`.                                                                                               |
| `--agent <id>` | Target a specific agent's sidecar (default: default agent).                                                                                                                 |
| `--json`       | Emit JSON (`[{ agentId, dbPath, initialized, resolution, outcome }]`; see "Ref-id resolution" above; `outcome` is `{ refId, found, salience }` on match, `null` otherwise). |
| `--verbose`    | Verbose logging for diagnostics.                                                                                                                                            |

Invalid `<value>` input — empty, `NaN`, `Infinity`, non-numeric strings, or `CLEAR` (case-sensitive) — is rejected before any database work. Empty strings are rejected explicitly so `Number("") === 0` cannot sneak through as a silent zero-salience write. **No range gating:** any finite number is accepted; operators who want bounds should enforce them externally. The rerank `salienceWeight` weight already reads this column (see the rerank table above), so salience writes take effect the next time the rerank pass runs.

### `memory sidecar supersede`

Record that one sidecar row is superseded by another — writes the `superseded_by` column on the `<old-ref-id>` row, linking it to the resolved `<new-ref-id>`. **Does not flip `status`**: an operator who wants both the link _and_ `status=superseded` runs `supersede` and `status` as two commands. Both positionals go through the shared ref-id resolver (see "Ref-id resolution" above). Use the literal sentinel `clear` in the second position to unlink a previously-recorded supersession (writes SQL `NULL` to `superseded_by`).

```
openclaw memory sidecar supersede <old-ref-id> <new-ref-id>
openclaw memory sidecar supersede <old-ref-id> clear
openclaw memory sidecar supersede <old-ref-id> <new-ref-id> --agent my-agent
openclaw memory sidecar supersede <old-ref-id> <new-ref-id> --json
```

| Option                  | Description                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------- |
| `<old-ref-id>`          | Required positional. The record being superseded. Full ref id or unique prefix.                                    |
| `<new-ref-id-or-clear>` | Required positional. The record that supersedes it, or the literal `clear` to unlink.                              |
| `--agent <id>`          | Target a specific agent's sidecar (default: default agent).                                                        |
| `--json`                | Emit JSON (`[{ agentId, dbPath, initialized, oldResolution, newResolution, outcome: { refId, found, supersededBy } | null }]`). |
| `--verbose`             | Verbose logging for diagnostics.                                                                                   |

Resolution runs on both positionals per agent. If `<old-ref-id>` misses or is ambiguous, the `<new-ref-id>` side is not consulted and nothing is written. If `<old-ref-id>` resolves but `<new-ref-id>` misses or is ambiguous, the error is labelled `target ref-id ...` so operators can tell which side of the supersede failed. Empty / whitespace-only `<new-ref-id>` is rejected up front — unlinking requires the explicit `clear` sentinel. The rerank `supersededPenalty` weight reads `status === "superseded"`, not the `superseded_by` link, so this command alone does not change rerank scoring; pair it with `status` when that is the intent.

If the sidecar database has not been initialized yet (for example, because `memoryV2.ingest.enabled` has never been on in this workspace), all six subcommands print a "sidecar not initialized" notice and exit without error.

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
