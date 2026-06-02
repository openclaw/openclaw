---
summary: "Plugin-author guide for implementing and registering a memory rerank provider on the builtin sqlite-vec backend"
read_when:
  - You are building a cross-encoder or reranker plugin for OpenClaw memory search
  - You want to reorder memory candidates by relevance before MMR diversification
  - You need to understand the MemoryRerankProvider contract
title: "Memory reranker"
sidebarTitle: "Memory reranker"
---

A memory rerank provider lets a plugin reorder the wide pre-MMR candidate pool
produced by the builtin sqlite-vec hybrid backend by cross-encoder relevance,
before the core applies MMR diversification, score filtering, and result trimming.

This seam is opt-in: no config is needed. Registration alone activates it.

<Note>
The rerank seam applies **only** to the builtin sqlite-vec backend. The QMD
backend has its own server-side reranking and does not call this hook.
</Note>

## The `MemoryRerankProvider` contract

Import the types from `openclaw/plugin-sdk/memory-core-host-runtime-core`:

```typescript
import type {
  MemoryRerankProvider,
  MemoryRerankCandidate,
  MemoryRerankScore,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
```

```typescript
interface MemoryRerankCandidate {
  ref: number; // core-assigned index; stable within a single search call
  snippet: string; // text excerpt for the cross-encoder
  source: string; // source tag (e.g. "sqlite-vec")
}

interface MemoryRerankScore {
  ref: number; // matches a candidate ref
  score: number; // normalized relevance in [0, 1]; higher = more relevant
}

interface MemoryRerankProvider {
  rerank(params: {
    query: string;
    candidates: MemoryRerankCandidate[];
    signal: AbortSignal;
  }): Promise<MemoryRerankScore[]>;
}
```

**Key constraints:**

- Return one `MemoryRerankScore` per input `ref`. Core rejects responses that
  drop, duplicate, or add refs.
- Scores must be in `[0, 1]`. Higher values are more relevant.
- The provider must return scored refs, not full result objects. It cannot modify
  candidate content or inject new results.
- Core owns the deadline and passes an `AbortSignal`. Honor it.

## Registering a provider

Call `api.registerMemoryRerankProvider(provider)` inside your plugin's
`register(api)` function:

```typescript
import type { MemoryRerankProvider } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

const myReranker: MemoryRerankProvider = {
  async rerank({ query, candidates, signal }) {
    // Call your cross-encoder here.
    // Return scores in [0, 1] for every candidate ref.
    return candidates.map((c) => ({ ref: c.ref, score: 0.5 }));
  },
};

export default definePluginEntry({
  // ...
  plugin: {
    register(api) {
      api.registerMemoryRerankProvider(myReranker);
    },
  },
});
```

## Manifest contract

A plugin that registers a memory rerank provider **must** declare
`memoryRerankProviders` in its `openclaw.plugin.json`. This follows the same
pattern as other provider contracts:

```json
{
  "id": "my-reranker",
  "contracts": {
    "memoryRerankProviders": ["my-reranker"]
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

See [Plugin manifest](/plugins/manifest) for the full `contracts` reference.

## Behavior and semantics

**Exclusive slot.** Only one plugin may register a memory rerank provider at a
time. If a second plugin attempts to register, the registration is rejected with
an error and the first provider remains active.

**Before MMR.** The reranker runs on the full pre-MMR candidate pool, not the
final result set. After reranking, core applies MMR diversification using the
reranked scores, then applies `minScore` filtering and result trimming.

**Fail-open.** If the provider returns an error or the core-owned deadline
expires, the search continues with the original pre-rerank candidate order.
No search results are lost due to reranker failure.

**No core config.** There is no `openclaw.json` toggle for the reranker. The
seam is active when a plugin has registered a provider and inactive otherwise.
To disable the reranker at the operator level, disable or uninstall the plugin
that registered it, or add a kill-switch inside the plugin's own config.

## Observing rerank state

The rerank state is visible in two places:

**`status().custom.rerank`** — check the plugin's own status output for
`disabled`, `active`, or `degraded`.

**Memory-search debug block** — when memory-search debug output is enabled, the
debug block includes a `rerank` field with the current state and timing.

## Related

- [Plugin SDK subpaths](/plugins/sdk-subpaths) — subpath catalog including `memory-core-host-runtime-core`
- [Plugin SDK runtime helpers](/plugins/sdk-runtime) — `api.runtime` reference
- [Plugin manifest](/plugins/manifest) — `contracts` field reference
- [Memory LanceDB](/plugins/memory-lancedb) — example memory plugin
