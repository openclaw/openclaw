# Plan: simplify memory provider cutover without schema changes

## Goal

Fix provider/model cutover so OpenClaw does not search mixed embedding vectors, without adding SQLite columns, changing DB file paths, adding config, or adding commands.

## Behavior

The memory DB remains a single-provider index.

If the DB metadata matches the current provider/model/settings, search works normally.

If the DB metadata does not match, vector search is paused and the index is marked dirty.

Search should not crash. It may return no vector results, or only trusted non-vector results if that path is safe.

The user sees a clear warning:

```text
Memory index was built for a different embedding provider or model. Vector memory search is paused until the index is rebuilt.
Run: openclaw memory status --index
```

## Repair path

Do not rebuild automatically on startup, normal status, or search.

Use existing commands only:

```sh
openclaw memory status --index
openclaw memory index --force
```

`openclaw memory status --index` should be allowed to repair a dirty/mismatched index because the user explicitly asked to index.

`openclaw memory index --force` remains the full rebuild path.

## Code changes

Remove the new chunk-level provider/provider_key columns and identity index from `packages/memory-host-sdk/src/host/memory-schema.ts`.

Remove per-row provider identity writes from `extensions/memory-core/src/memory/manager-embedding-ops.ts`.

Remove provider/provider_key filtering from `extensions/memory-core/src/memory/manager-search.ts`.

Keep the DB-level identity check in `extensions/memory-core/src/memory/manager-reindex-state.ts`, but make it a trust gate, not a schema migration.

In `extensions/memory-core/src/memory/manager.ts`, skip vector search when identity is missing or mismatched.

In status output, show the mismatch reason and the existing repair command.

In sync, avoid automatic full reindex except when the call came from an explicit indexing command.

## Tests

Update provider cutover tests to expect no vector results and a dirty/warning state instead of gradual mixed-row repair.

Keep tests for missing metadata and mismatched provider/model.

Add or keep CLI status coverage for the warning and repair command.

Remove tests that depend on per-row provider identity.

## Tradeoff

This does not gradually repair mixed rows.

That is intentional.

Without changing the data model, OpenClaw cannot know which individual rows belong to which provider.

The safe behavior is to stop trusting the whole vector index until the user explicitly rebuilds it.
