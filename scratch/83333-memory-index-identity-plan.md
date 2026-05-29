# Memory Index Identity Fix Plan

Issue: https://github.com/openclaw/openclaw/issues/83333

## Goal

Make a memory index healthy only when its stored identity matches the active memory config and embedding provider.

The current bad state is:

- config now wants `ollama` / `nomic-embed-text`
- SQLite metadata still describes an old OpenAI index
- `memory status --deep` can show `Dirty: no`
- search can silently return no useful vector matches

## Production Invariant

Every path that trusts the memory DB must answer the same question:

> Does this index belong to the active memory provider, model, provider key, sources, scope, chunking, tokenizer, and vector state?

If no, the index is stale. It must be dirty, invalid, or rebuilt. It must not be reported as clean.

## Current Gap

The explicit indexing path already checks provider/model/providerKey mismatch through `shouldRunFullMemoryReindex` in `extensions/memory-core/src/memory/manager-reindex-state.ts`.

The status-only path does not. `MemoryIndexManager` reads `meta.vectorDims`, then `resolveInitialMemoryDirty` treats any existing metadata as clean for status managers:

- `extensions/memory-core/src/memory/manager.ts`
- `extensions/memory-core/src/memory/manager-status-state.ts`
- `extensions/memory-core/src/cli.runtime.ts`

That lets deep status combine new provider info with old index metadata.

## Fix Shape

1. Extract a shared index identity check.
   - Reuse the comparison logic behind `shouldRunFullMemoryReindex`.
   - Return a structured result: `valid`, `missing`, or `mismatched`.
   - Include a short mismatch reason for status output and tests.

2. Use that check when constructing status-only managers.
   - Read stored metadata.
   - Build expected identity from current settings and initialized provider when available.
   - If identity does not match, set `dirty = true`.

3. Make `memory status --deep` validate after provider initialization.
   - Deep status probes initialize the provider.
   - Re-run the identity check after that point.
   - Never print `Dirty: no` when provider/model/providerKey metadata mismatches.

4. Protect search bootstrap.
   - Before trusting existing vector rows, validate index identity.
   - If stale and sync is allowed, trigger the safe reindex path.
   - If stale and sync cannot run, return a degraded/mismatch state instead of silently acting healthy.

5. Keep rebuilds atomic.
   - Provider/model identity changes should use the existing safe temp-DB reindex and swap.
   - Do not patch mixed-provider rows in place.

## Non-Goals

- No Ollama special case.
- No config migration.
- No plugin API change unless implementation proves memory-core lacks required identity data.
- No hardcoded vector dimension rules such as `1536 means OpenAI`.

## Tests

Add focused tests for:

- status-only manager marks mismatched provider/model metadata dirty
- `memory status --deep` does not report clean after OpenAI metadata with Ollama config
- manual `memory index` still reuses the same identity check
- search does not silently return a healthy empty vector result from a mismatched index

Suggested commands:

```sh
node scripts/run-vitest.mjs \
  extensions/memory-core/src/memory/manager-status-state.test.ts \
  extensions/memory-core/src/memory/manager-reindex-state.test.ts \
  extensions/memory-core/src/memory/manager-search.test.ts \
  extensions/memory-core/src/cli.test.ts
```

## Optional Live Proof

If feasible before landing, run a Docker or Crabbox smoke:

1. Build a small OpenAI-style memory index.
2. Switch `agents.defaults.memorySearch` to Ollama.
3. Run `openclaw memory status --deep`.
4. Confirm status is dirty or invalid, not clean with stale dimensions.

Unit proof is enough for the core invariant. Live proof is useful for confidence, not a reason to special-case Ollama.
