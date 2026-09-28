---
summary: "The exclusive context-engine and memory-capability slots and their embedding adapters"
title: "Plugin SDK memory and context slots"
sidebarTitle: "Memory and context slots"
read_when:
  - You are registering a context engine or a memory capability
  - You need the durable admitted-turn contract for context engines
  - You are exposing memory embedding or public-artifact adapters
---

The registrars that allow only one active implementation at a time, and the
memory adapter contracts that sit on top of them. Part of the
[Plugin SDK overview](/plugins/sdk-overview).

## Exclusive slots

| Method                                     | What it registers                                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api.registerContextEngine(id, factory)`   | Context engine (one active at a time). Use `info.acceptedHostParams` to restrict accepted host-added lifecycle fields, including optional `maintain()` cancellation; undeclared engines receive all current host fields. |
| `api.registerMemoryCapability(capability)` | Unified memory capability                                                                                                                                                                                                |

To participate in durable admitted turns, context engines must declare
`currentTurnFence: "before-current-turn-entry-v1"` and
`turnAdvancementIdempotency: "atomic-idempotent-v1"` under
`info.transcriptSemantics`, then implement `commitTurn(...)` as an atomic,
idempotent write keyed by `advancementKey`. OpenClaw supplies only the inclusive
accepted turn, from its admitted user entry through its terminal entry. Use the
reset-aware transcript admission API below to bootstrap or rebuild context;
visible-history cursors are for archive/search/export, not reset eligibility. Without the full contract, OpenClaw uses the legacy
context path for the whole logical turn and its retries, leaves the configured
engine unchanged, and tries that engine again on the next logical turn.

## Reset-aware transcript admission

Use `api.runtime.agent.session.readTranscriptAdmission` and `api.runtime.agent.session.acceptTranscriptAdmission`. These are typed, lazy host capabilities on the existing Plugin SDK runtime; no private SDK subpath is needed. Supply the exact `agentId`, `sessionKey`, `sessionId`, and the host-provided `storePath` when present. This contract supports durable SQLite sessions, not incognito sessions.

A `snapshot` combines canonical message entry IDs, normalized branch parent IDs, raw sequence metadata, persisted payloads, the transcript `generation`, an explicit nullable reset `boundary`, and a one-use opaque `token`. Clear resets select only subsequent messages. Preserve-tail resets select the host-retained tail, including paired tool results, and subsequent messages. Selection uses the host's active branch and reset rules. It does not apply host compaction, introduce summaries, or change raw/visible history APIs. Within an admitted turn, bootstrap excludes that turn's user entry and later entries. A reset retiring that admission returns `stale`, not historical context.

Prepare expensive work from the snapshot, then persist it **inside** acceptance:

```ts
const { readTranscriptAdmission, acceptTranscriptAdmission } = api.runtime.agent.session;
const snapshot = await readTranscriptAdmission(sessionTarget);
if (snapshot.kind !== "snapshot") return;
const prepared = await prepareImport(snapshot.entries);
const accepted = await acceptTranscriptAdmission(snapshot.token, async (boundary) => {
  // One plugin-owned atomic transaction reconciles its conversation and entry IDs.
  await commitImport({ generation: snapshot.generation, boundary, prepared });
});
if (accepted.kind === "stale") {
  // Discard prepared work; get a new snapshot on the next reconciliation.
}
```

Acceptance rechecks the captured physical store, session lifecycle, transcript version, and reset boundary inside the canonical host writer queue. The queue remains owned until the plugin callback settles, so host reset, branch, and rewrite operations cannot overtake plugin persistence. Keep the callback short: commit already-prepared work only to the plugin's own store, and await all of it. Do not call host session mutations or recursively accept another snapshot from this callback; those operations need the same queue. This is host lifecycle serialization, **not** a distributed transaction across plugin and host databases. It does not coordinate unsupported independent writers to a running host's SQLite files. Plugin crash recovery and idempotence remain plugin-owned.

Tokens are process-local and consumed once, including when a callback fails. Reset, branch/rewrite, session replacement, and even ordinary append invalidate detached work. Persist the generation/boundary association, never the token. `missing` and `stale` are distinct from a valid empty snapshot; storage, integrity, or worker failures reject the read and must not initialize an empty conversation. A plugin callback failure propagates without automatic replay.

Treat reset lifecycle notifications as **reconciliation hints**, not instructions to archive whichever conversation happens to be current. On every hint and on bootstrap/restart, read and accept a current snapshot. Atomically associate its `generation` and nullable boundary with the plugin-owned conversation. Repeated hints for that association are no-ops; a delayed older hint therefore cannot archive a newly bootstrapped context. Boundary `rawSeq` orders reset events only within its `generation`; timestamps and lexical ID order grant no admission. Keep archived plugin rows and summary DAG ownership in the plugin.

Durable `commitTurn` delivery is fenced by the same host owner and has the same short, plugin-store-only callback restrictions. Its optional `resetBoundary` field records the admitted boundary (`null` means none). Turns retired by reset or detached by branch/rewrite never enter the fresh context; their pending payload stays as blocked outbox evidence. Existing raw transcript history is not deleted. Older hosts omit this field; consumers must pin and test a host version implementing the complete contract before claiming reset-aware support.

## Memory embedding adapters

- `registerMemoryCapability` is the exclusive memory-plugin API.
- A selected memory plugin may omit `capability.runtime`, including when it
  handles memory through its own hooks. The Memory settings page reports absent
  host search support neutrally; this does not assess other memory integrations.
  Plugin loading and search-runtime failures remain errors.
- `registerMemoryCapability` may also expose `publicArtifacts.listArtifacts(...)`
  for host-managed exports. Companion plugins that enumerate those declared
  artifacts still use `listActiveMemoryPublicArtifacts(...)` from the retained
  `openclaw/plugin-sdk/memory-host-core` facade until a focused public consumer
  API exists; they must not reach into another plugin's private layout.
- A memory runtime that can return session-transcript hits should implement
  `runtime.authorizeSearchHits(...)`. The host calls this hook before raw search
  hits reach caller-visible surfaces and supplies the requesting agent, session
  key, and sandbox state. Return only hits the requester may observe. If the hook
  is absent, OpenClaw fails closed by withholding session-source hits while
  retaining ordinary memory hits. Keep transcript identity and visibility
  policy in the owning memory plugin; callers must not infer authorization from
  paths or duplicate plugin-specific rules.
- `MemoryFlushPlan.model` can pin the flush turn to an exact `provider/model`
  reference, such as `ollama/qwen3:8b`, without inheriting the active fallback
  chain.
- Embedding providers use `api.registerEmbeddingProvider(...)` and
  `contracts.embeddingProviders`; there is no separate memory-only registry.

## Bundled Memory Core workers

Memory Core uses the shared `process-runtime` worker pool for lexical retrieval,
cosine fallback, and immutable chunk preparation. Retrieval retains the search
generation until its readers close; publication, source-hash validation, and
forget operations remain with their existing database owners.

Bundled workers use the private `memory-core-host-engine-knn` facade for
read-only database access, the shared SQLite idle lifetime, and vector primitives, and
`memory-core-host-engine-indexing` for pure chunking, annotations, hashes, and
embedding input limits. These facades avoid loading provider registries or
writable-store initialization into worker threads. They are bundled runtime
contracts, not third-party typed SDK entrypoints.
