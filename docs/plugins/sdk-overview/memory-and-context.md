---
summary: "The exclusive context-engine and memory-capability slots and their embedding adapters"
title: "Plugin SDK memory and context slots"
sidebarTitle: "Memory and context slots"
read_when:
  - You are registering a context engine or a memory capability
  - You need the durable admitted-turn contract for context engines
  - You are exposing memory embedding or public-artifact adapters
  - You need to authorize provider memory by owner or conversation audience
  - You are implementing provider-owned pre-compaction persistence
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
`info.transcriptSemantics`, then implement `commitTurn(...)` as an atomic
write keyed by `advancementKey` that has no additional effect when repeated. OpenClaw supplies only the inclusive
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
  is absent, OpenClaw withholds session-source hits while
  retaining ordinary memory hits. Keep transcript identity and visibility
  policy in the owning memory plugin; callers must not infer authorization from
  paths or duplicate plugin-specific rules.
- Embedding providers use `api.registerEmbeddingProvider(...)` and
  `contracts.embeddingProviders`; there is no separate memory-only registry.

Memory Core implements `runtime.searchForCli(...)` for Gateway-routed CLI
searches. The host passes the acquired manager, requested agent, query, and
current mutation guard to that same runtime instance. This keeps recall
recording in the instance's configured state store so later dreaming sweeps
can promote it. Other memory plugins continue to expose their own search tools.

## Pre-compaction memory flush

Register a flush resolver on `MemoryPluginCapability` to supply the silent
turn that saves durable context before compaction. OpenClaw resolves flush
timing first from `agents.defaults.compaction.memoryFlush` and the active
context window. When `enabled` is `false`, the host does not invoke the
resolver. Return `null` to skip the flush for provider-specific reasons.

There are two resolver fields:

- `flushPlanResolver` returns a complete `MemoryFlushPlan` or `null`. Its
  contract is unchanged from earlier releases. Memory Core uses it.
- `providerFlushPlanResolver` returns a plan the host completes: a
  `MemoryFlushFilePlanDraft` (a complete `MemoryFlushPlan` is one such draft)
  or a `MemoryFlushToolsPlan`. When a plugin registers both, the host uses
  `providerFlushPlanResolver`.

Each plan has `prompt`, `systemPrompt`, and one persistence arm. In plans from
`providerFlushPlanResolver`, the `softThresholdTokens`,
`forceFlushTranscriptBytes`, `reserveTokensFloor`, and `model` fields are
deliberate provider overrides. The host fills omitted timing fields from its
resolved timing, and fills an omitted `model` from `memoryFlush.model` for the
tools arm only; a file plan without `model` keeps the session's model. A `model` override pins the turn
to an exact `provider/model` reference, such as `ollama/qwen3:8b`, without
inheriting the active fallback chain.

Choose exactly one persistence arm:

| Arm   | Plan fields                                                                                                      | Flush tools and storage                                                                                                                                                                                        |
| ----- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File  | `relativePath: string`                                                                                           | `read` and an append-only `write` restricted to the target file. The host creates the target and requires writable workspace access. Memory Core uses this arm.                                                |
| Tools | `persistenceToolNames: readonly string[]` (non-empty), optional `lookupToolNames: readonly string[]` (read-only) | `read` plus the declared persistence and lookup tools owned by the selected memory plugin. The host creates no target file and does not require writable workspace access. Lookup tools cannot persist memory. |

Only the selected memory slot owner may supply a tools-arm plan, through
`providerFlushPlanResolver`. The host tracks which plugin supplied the effective
resolver, including when sidecar capability fields are merged; an owner's
resolver of either kind wins over a sidecar's. A tools-arm plan from a non-owner is skipped with a warning
naming that plugin.

For the tools arm, ownership comes from registered tool metadata. A same-named
tool from another plugin is excluded. Normal message, model, sandbox, allowlist,
and authorization policies still apply after this projection. Persistence and
lookup tool names must not overlap; the host skips an overlapping plan and warns
with the plugin name. If none of the declared persistence tools survives, the
host skips inference and logs a warning naming the missing tools. If policy
removes any lookup tools, the flush still runs with its surviving persistence
tools and logs one warning naming the unavailable lookup tools. Compaction can
continue after a skipped flush.

### Audience and flush identity

The flush runs in a detached internal session so its maintenance transcript does
not enter later user turns. For a tools-arm turn, the host resolves the source
turn's `memoryAudience` from its trusted session entry, session key, session ID,
and the source turn's sender ownership, including for a flush scheduled after the
turn completes. It delegates that audience to the detached session key,
retaining the source lineage and revocation checks. Persistence and lookup tools
receive this delegated audience and the source sandbox state. If the source has
no valid audience, the host skips the tools-arm flush with a debug log. The
maintenance copy still has `senderIsOwner: false`; providers authorize memory
access through the supplied audience and its current-authority check.

Only tools-arm flush contexts include `memoryFlush: { flushId: string }` on
`OpenClawPluginToolContext`. The host computes `flushId` from
the source session incarnation (its `sessionId` and lifecycle revision) and its
pre-compaction `compactionCount` (zero when absent). The count advances after a
completed compaction, so model fallback attempts and later retries within the
same cycle share an ID; a later cycle or a new session incarnation, including a
reset that keeps the session ID, gets a different ID. Providers can combine this ID with
their mutation's identity to deduplicate retries. The ID does not grant authority.

### Completion evidence

A tools-arm flush succeeds only when at least one declared persistence tool
completes without error, or the assistant's final output is the silent token
`NO_REPLY`. A successful lookup call is not persistence evidence. Without either
valid completion signal, the host records a failed flush with the reason `no
persistence tool call succeeded`. Run errors still fail the flush. The file arm
retains its file-writing and completion behavior.

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

The selected memory slot owner can also declare `recallToolNames`. These are
the concrete agent tools Active Memory uses for deep recall. A valid explicit
Active Memory `toolsAllow` list takes precedence, followed by the selected
provider's `recallToolNames`, then the built-in fallback. Unselected sidecars
cannot contribute this field. For a native provider, `recallToolNames` also
gates provider-direct trigger recall: Active Memory runs it only when the
declaration is non-empty and the turn's tool policy allows every declared tool.
Otherwise it skips the provider lookup and injects nothing.

### Host consumers

| Host consumer                          | Provider runtime use                              | Native provider declaration                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway `memory.search` v2             | `search()`                                        | Requested `sources`; `pagination: true` for cursors                                                                                                                           |
| Gateway `memory.get` / `memory.status` | `get()` / `health()`                              | Required handle methods                                                                                                                                                       |
| Doctor and CLI status                  | `health()` with operator or host/status authority | Health must accept status callers                                                                                                                                             |
| Post-compaction refresh                | Optional `refresh()`                              | No capability flag; omission or denial is logged                                                                                                                              |
| Project recall                         | `candidates({ kind: "project" })`                 | `candidates: ["project"]` and `projectFilter: true` when project keys are supplied                                                                                            |
| Active Memory trigger recall           | Lexical `search()` plus trigger candidates        | `sources: ["memory"]`, `candidates: ["trigger"]`, non-empty `recallToolNames` the turn's tool policy allows in full, and `projectFilter: true` when project keys are supplied |
| Active Memory deep recall              | Agent tools                                       | Selected owner declares and registers `recallToolNames`                                                                                                                       |
| Voice fast context                     | `search()`                                        | Every configured source                                                                                                                                                       |
| Memory Wiki                            | `search()`                                        | Requested sources; protected transcript recall requires `"sessions"`                                                                                                          |

The required `MemoryCallerContext` carries an `assertCurrent()` callback, an
optional abort signal, and `MemoryCallerAuthority`:

- `operator`: authenticated operator scopes and optional connection identity;
- `session`: the actual session key, optional session ID, sandbox state, and an
  optional host-resolved memory audience. `conversationRecall` carries the
  bounded recall pass the host granted that session's tool context, such as an
  Active Memory recall run; copy it only from that trusted context, never from
  model input;
- `host`: a named host operation, not an operator or private-session grant.

The host rechecks caller and plugin lifetime before and after asynchronous
operations. Providers apply visibility policy from the supplied authority and
revalidate before releasing data. A session authority without an audience has no
private or conversation grant. A host authority also grants neither private nor
conversation access.

### Memory audience

OpenClaw resolves memory audience once from trusted turn facts and durable
session lineage. Providers and plugin tools consume the resulting host-minted
value:

```ts
type MemoryAudience =
  | { kind: "owner-private"; agentId: string }
  | { kind: "conversation"; agentId: string; sessionKey: string; sessionId: string };
```

- A direct turn from the trusted agent owner has `owner-private` audience.
- A direct turn from another sender, or a group, channel, or thread turn, has
  `conversation` audience for the durable root session.
- A spawned child inherits its root audience only after the host validates each
  recorded parent key, session ID, and lifecycle revision.
- Missing, malformed, cross-agent, cyclic, or stale lineage produces no
  audience. Unknown or missing durable chat type also produces no audience.

Audience is separate from sandbox policy. A provider can deny sandboxed callers
even when they have a valid audience. Operator authority is also separate and
explicit; it does not become owner-private session authority.

Providers must not reconstruct audience from session lookups, session-key
patterns, record IDs, or cached fingerprints. They must also reject an audience
for another agent. The host binds each audience to its invocation session and
rejects it when presented for another session. Host-mediated child runs receive
a new audience bound to the child session's current session ID and lifecycle
revision (or, for a detached child run, to the absence of a row for its key),
sharing the parent's lineage and revocation state; a child reset or
reassignment rejects it as well. The host rejects audience objects that it did
not mint and invalidates a captured audience when any session in its lineage
changes incarnation or lifecycle, or when the run that owns it ends. The host
checks audience currency before and after opening a provider and around every
provider call. The `context.assertCurrent()` passed to `open()` includes audience
currency, so a provider that calls it immediately before I/O, including after its
own awaited work, is refused instead of acting under stale authority. Session
writes that keep the session ID and lifecycle revision, such as a turn's own
activity and usage bookkeeping, do not interrupt these checks while they publish;
a pending reset, replacement, or deletion still reports currency as unavailable
until it settles, then revokes the audience. Audience revocation does not abort
`context.signal`; call `assertCurrent()` before each effect.

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
