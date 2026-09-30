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
accepted turn, from its admitted user entry through its terminal entry; use the
`readSessionTranscriptVisibleMessageDelta(...)` cursor API to bootstrap or
rebuild earlier history. Without the full contract, OpenClaw uses the legacy
context path for the whole logical turn and its retries, leaves the configured
engine unchanged, and tries that engine again on the next logical turn.

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
  key, and sandbox state. Return only hits the requester may observe. For a host
  or operator caller without a session, the host sets `trustedAgentScope`;
  return that agent's own session hits and no other agent's. When a session
  caller carries a host-granted conversation recall pass, the host forwards it
  as `conversationRecall`; admit only the hits that pass allows. If the hook
  is absent, OpenClaw fails closed by withholding session-source hits while
  retaining ordinary memory hits. Keep transcript identity and visibility
  policy in the owning memory plugin; callers must not infer authorization from
  paths or duplicate plugin-specific rules.
- `MemoryFlushPlan.model` can pin the flush turn to an exact `provider/model`
  reference, such as `ollama/qwen3:8b`, without inheriting the active fallback
  chain.
- Embedding providers use `api.registerEmbeddingProvider(...)` and
  `contracts.embeddingProviders`; there is no separate memory-only registry.

## Provider-neutral memory runtime

The provider-neutral runtime lets a record-based provider own the memory slot
without impersonating workspace files. The legacy file-shaped
`MemoryPluginRuntime` contract remains intact. Success means:

- existing legacy providers continue to work without changes;
- a record-only provider can serve every reader whose declared needs it supports;
- unsupported operations are declared as capabilities, not discovered by calling
  the provider and handling failure.

The integration has three layers:

1. The host selects one provider, supplies trusted caller authority, owns the
   caller-bound lifecycle, and routes requests.
2. `providerRuntime` supplies neutral search, retrieval, and health through
   provider-scoped references and declared capabilities.
3. Provider-owned tools, skills, and UI retain rich workflows such as mutation,
   organization, and maintenance. The neutral runtime does not replace them.

External plugins derive provider types from the already-public
`MemoryPluginCapability`; `memory-host-search` remains a private-local facade for
bundled consumers.

```ts
import type { MemoryPluginCapability } from "openclaw/plugin-sdk/memory-host-core";

type MemoryProviderRuntime = NonNullable<MemoryPluginCapability["providerRuntime"]>;
type MemoryProviderOpenResult = Awaited<ReturnType<MemoryProviderRuntime["open"]>>;
type MemoryProviderHandle = NonNullable<MemoryProviderOpenResult["provider"]>;

const providerRuntime: MemoryProviderRuntime = {
  async open({ agentId, context }) {
    // Reuse the plugin's service. Routing facts and record IDs do not grant access.
    const provider: MemoryProviderHandle = await service.openMemoryReader({ agentId, context });
    return { provider };
  },
};

api.registerMemoryCapability({ providerRuntime });
```

`service.openMemoryReader` is provider-owned code. It returns a caller-bound
`MemoryProviderHandle` with these members:

| Member                | Contract                                                                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capabilities`        | Required declaration of supported sources, pagination, candidate kinds, and project filtering.                                                                                                                                                           |
| `search(request)`     | Returns hits and optional pagination, coverage, and warning fields. Each hit has a provider-scoped `reference` and an `excerpt`; scores and citations are optional. Every provider must honor `minScore`. `lexicalOnly` is a hint a provider may ignore. |
| `get(request)`        | Resolves a provider-scoped reference with optional revision and read bounds. Returns explicit `ok` or `not_found`; denial and failure must not become empty success.                                                                                     |
| `health()`            | Returns `ready`, `degraded`, or `unavailable` without revealing partition content. It must work for every authenticated caller, including host authority opened with purpose `status`; search and get may still deny that caller.                        |
| `close()`             | Releases this caller's lease without shutting down another caller's shared service.                                                                                                                                                                      |
| `candidates(request)` | Present exactly when `capabilities.candidates` is non-empty. Eligible results include provider-owned project or trigger metadata; search support alone does not enable automatic injection.                                                              |
| `refresh()`           | Optional provider-owned refresh. This is not a generic dreaming, repair, or deletion API.                                                                                                                                                                |

Capabilities are enforced before provider code runs:

| Capability        | Declaration                                                         | Rejected request                                                          |
| ----------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Search sources    | non-empty `sources` array containing `"memory"` and/or `"sessions"` | `sources` contains an undeclared corpus                                   |
| Pagination        | `pagination: boolean`                                               | `cursor` is present when pagination is false                              |
| Automatic recall  | `candidates` array containing `"trigger"` and/or `"project"`        | `candidates({ kind })` names an undeclared kind                           |
| Project filtering | `projectFilter: boolean`                                            | non-empty `activeProjectKeys` is supplied when project filtering is false |

The required `MemoryCallerContext` carries an `assertCurrent()` callback, an
optional abort signal, and `MemoryCallerAuthority`:

- `operator`: authenticated operator scopes and optional connection identity;
- `session`: actual session key, sandbox state, and available trusted session
  incarnation, owner, and chat-type facts. `conversationRecall` carries the
  bounded recall pass the host granted that session's tool context, such as an
  Active Memory recall run; copy it only from that trusted context, never from
  model input;
- `host`: a named host operation, not an operator or private-session grant.

The host rechecks caller and plugin lifetime before and after asynchronous
operations. Providers apply visibility policy from these trusted facts and
revalidate before releasing data. Missing owner or chat facts are unknown, not
evidence of a private conversation. Never reconstruct authority from a session
lookup, record ID, or cached fingerprint.

### Compatibility and host integration

- Consumers prefer `providerRuntime`. Only its absence selects the host-owned
  legacy adapter. Failure, denial, or an invalid provider runtime never retries
  against legacy storage.
- Existing plugin registration, `MemoryPluginRuntime`, manager types, and
  `getActiveMemorySearchManager` remain available. Existing plugins need no source
  or storage migration.
- The legacy adapter declares memory and session search, no pagination, project
  filtering, and no automatic-recall candidates. It preserves manager receivers,
  virtual paths, read bounds, visibility filtering, and cleanup. Its health details
  omit host paths such as the database and workspace locations.
- Provider references include `providerId`; another selected provider's reference
  is rejected. Providers own revision behavior and must not substitute unrelated
  content for a stale reference.
- The Gateway exposes neutral search with `memory.search` and `version: 2`,
  retrieval with `memory.get`, and health with `memory.status`. Any authenticated
  operator connection with `operator.read` can call them, the same callers as
  unversioned `memory.search`, including token-authenticated CLI connections.
  In-process agent-tool and agent-runtime callers use their admitted run's
  operator authority instead. Request abort, connection close, and revoked
  client authority are rechecked before and after every provider call. Omitting
  the search version, or sending `version: 1`, retains the old file-shaped
  response for legacy providers. A native provider returns an error naming the
  selected plugin and directs the client to retry with `version: 2`.
- Voice fast context, project recall, Active Memory trigger recall, and Memory Wiki
  use the neutral interface when the selected slot owner registers
  `providerRuntime` and declares their required capabilities. With a legacy
  runtime, they keep their manager calls, results, and citation labels.
- A record-only provider keeps its own tools, skills, and UI; selection does not
  create a fake file browser. Older hosts ignore `providerRuntime`, so plugins that
  require it must declare a compatible host version.

This is the shared read runtime. Memory Core tools and CLI, file-index diagnostics,
startup workspace files, pre-compaction saving, reset capture, and maintenance keep
their existing ownership. Native provider workflows continue alongside it.

### Dreaming remains separate

Dreaming is not a provider runtime capability. Selecting another memory plugin can
still activate Memory Core as a dreaming sidecar under the existing loader policy.
Explicitly disabling Memory Core prevents that sidecar. The Dreams UI and file-backed
maintenance methods do not imply that the selected provider implements dreaming.

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
