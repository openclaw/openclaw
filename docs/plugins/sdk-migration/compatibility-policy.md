---
summary: "The external-plugin compatibility policy and the dated per-surface compatibility records"
read_when:
  - You need to know whether a compatibility surface is still supported
  - You are checking the removal condition for a specific retained contract
title: "Compatibility policy and records"
sidebarTitle: "Compatibility records"
---

The order compatibility work follows, and the per-surface records that say what is retained, why, and on what condition it can be removed. Part of the [Plugin SDK migration](/plugins/sdk-migration) guide.

## Compatibility policy

External-plugin compatibility work follows this order:

1. Add the new contract.
2. Keep the old behavior wired through a compatibility adapter.
3. Emit a diagnostic or warning naming the old path and replacement.
4. Cover both paths in tests.
5. Document the deprecation and migration path.
6. Remove only after the announced migration window, usually in a major
   release.

SQLite and SDK writer migrations use one shared runtime warning budget per plugin
identity and deprecated capability family per Gateway process. Warnings occur on
actual legacy use, never import, and survive plugin reloads. They name the invoked
method, supported replacement, current compatibility promise, and “removed in the
next Plugin SDK major.” Unknown direct SDK consumers share one bounded SDK-level
warning per family. Diagnostics contain no database paths, credentials, payloads,
or stack dumps. This policy replaces the earlier no-new-runtime-warnings rule for
these writer migrations; documentation-only reader records retain their own policy.

Synchronous compatibility calls still commit before returning. Awaited mutations
complete only after committed facts have been installed. SessionManager and its
extension/provider adapters share the session-persistence warning budget.

### Harness deletion companions

Unbound `AgentHarnessSessionDeletionMutation` callbacks are deprecated. During
Gateway operation, OpenClaw commits file-backed session deletion in its worker before
calling the opaque `commit` callback. It does not invoke the opaque `rollback`
callback when that database transaction fails, because the companion has not
been changed. Legacy use emits one deprecation warning per plugin and callback
family. The unbound callback contract is removed in the next Plugin SDK major.

Wrap best-effort external cleanup in `createNativeSessionCommitFinalizer` from
`openclaw/plugin-sdk/agent-harness-session-runtime`. A failed legacy callback is
logged as a cleanup warning; it does not undo an acknowledged session deletion.
A process exit after the session commit can leave companion cleanup unfinished,
so cleanup must tolerate an absent session and be safe to retry.

Use the existing native session binding lifecycle for reversible plugin-state
changes that must settle with session deletion. Its worker receipt and rollback
preserve those storage guarantees. Initializer rollback is marked complete only
after the same receipt acknowledges deletion. Explicit stopped-owner Doctor/CLI
maintenance retains its admitted native transaction, as does the process-local
incognito owner during its separate migration.

### Retained helper contracts

Transcript append and lock preparation now uses
[`preparation.prepareMessage`, `preparation.source`, and `withSessionTranscriptWrite`](/plugins/sdk-migration/how-to-migrate#await-locked-transcript-preparation).
The `transcript-lock-sync-message-preparation` and
`transcript-strict-sync-message-preparation` records retain the old lock functions,
`prepareMessageAfterIdempotencyCheck`, and `beforeFreshMessageCommit` for durable
targets with their original transaction ordering. One deprecation warning is
emitted per plugin for this family. Incognito and actor-bound targets reject the
old form with an actionable replacement error. The old exports and fields remain
available to compile existing plugins and will be removed at the **next Plugin SDK
major**. This target-specific deprecation does not activate actor routing for
ordinary incognito sessions or change stored data, schema, retention, or updates.

Discord and llama.cpp retain their declared OpenClaw 2026.9.2 host support.
They use the newer prepared-expiry, DM-policy refinement, and live-catalog outcome
helpers when those exports are available, with plugin-local fallbacks for the
2026.9.2 SDK. The fallbacks preserve Discord's timestamp validation, idle-first
expiry ties, and root/account DM-policy validation through the older SDK
validators, and llama.cpp's ready, authentication-rejected, and unavailable catalog outcomes
with credential-profile attribution. They do not retry or suppress errors from
an available newer helper. Remove these fallbacks only when the declared plugin
API floor no longer includes 2026.9.2; test built plugin imports against that
minimum host before changing unconditional SDK imports.

Voice Call also retains its declared 2026.9.2 host support. Its realtime upgrade
handler keeps the two HTTP rejection responses local because that SDK has no
`websocket-runtime` subpath. Rejection bytes flush before the socket is destroyed,
and socket errors retain their normal cleanup behavior. Remove this local
transport compatibility code only when the declared plugin API floor excludes
2026.9.2.

Retained compatibility entrypoints keep their shipped caller names:
`inbound-envelope` uses `resolveStorePath`, `provider-catalog-runtime` exports
`resolvePluginProviders`, and `agent-runtime`'s
`resolveThinkingDefaultWithRuntimeCatalog` accepts `loadModelCatalog`.

`resolvePluginProviders` remains synchronous and returns the existing provider
array. When it borrows from an owned inspection, the Gateway lifecycle or
executable CLI invocation retains the backing resources until its actual work
and cleanup finish. Finish calls using those providers before the host closes;
keeping the array does not authorize use after host retirement. A released
inspection stays retired, and a new lookup through that inspection is refused.
Callers outside an OpenClaw host retain the standalone process lifetime of this
SDK contract; process exit does not guarantee asynchronous plugin disposal.

Inspection release relinquishes the inspection's own claim. If an SDK host
still borrows the same source, final disposal belongs to that host. The host
reports later disposal failures during teardown; they cannot retroactively
change an already returned inspection result. Internal provider resolvers do
not acquire this compatibility lifetime.

`text-chunking` retains positional `CodeRegion` inputs with `start` and `end`
offsets for `isInsideCode`. Regions returned by `findCodeRegions` additionally
include parser-owned `block` metadata; callers supplying their own ranges do not
need to provide it.

### Harness tool construction

Harnesses should await `params.hostCapabilities.createToolSurfaceAsync(options,
bindingOptions?)`. Each construction reads fresh exec policy through the existing
worker, then binds tools to the exact admitted host. Ordinary exec-approval read
errors use conservative deny defaults. Migration errors and authority loss reject
construction; callers must not retry through the synchronous factory.
The public `createOpenClawCodingToolsAsync(options?)` factory from
`openclaw/plugin-sdk/agent-harness` provides the same awaited preparation for
non-harness callers. Harnesses use the host capability to retain its source
authority and private bindings.

The synchronous `createToolSurface` and `createOpenClawCodingTools` contracts
shipped in OpenClaw 2026.9.8 remain available with their existing arguments,
array results, and completion timing. TypeScript marks them deprecated for
removal at the next Plugin SDK major, subject to explicit breaking-release
approval. Bundled callers use the awaited factories. This migration changes no
stored data, schema, retention, or update behavior.

### WebSocket options and constructors

`websocket-runtime` retains the `ws.ClientOptions` alias and `WebSocket`
constructor signatures shipped in OpenClaw 2026.9.6. Host-internal TLS type
corrections must not change plugin callback typing or constructor overloads.
A source-incompatible correction to this public contract requires an approved,
versioned SDK migration.

### Gateway worker environment creation

`GatewayRequestHandlerOptions` from `core` and `gateway-runtime` retains the
worker-environment creation contract shipped in OpenClaw 2026.9.5. When
`context.workerEnvironmentService` is available, its `create` method accepts
positional arguments in this order: `profileId`, `idempotencyKey`, `machineClass?`,
`executionMode?`, `projectPath?`, `signal?`, `os?`, and `runSetupScript?`.
Idempotent retries and caller cancellation keep their existing behavior across
host upgrades. Changing this contract requires an explicitly approved SDK
migration.

### Gateway placement and publication readers

The Gateway context exposed by `GatewayRequestHandlerOptions` from `core` and
`gateway-runtime`, and by `getPluginRuntimeGatewayRequestScope()` from
`plugin-runtime`, retains these synchronous contracts shipped in OpenClaw
2026.9.7:

- `workerSessionPlacementService.listPendingWorkspaceResults(sessionId?)`
  returns the pending result array.
- `workerSessionPlacementService.getWorkspaceResultReconcilingSessionIds(sessionIds)`
  returns a `ReadonlySet<string>`.
- `githubPublicationService.deferOrphanedRequests()` returns `void` after
  orphaned requests have been deferred.

Migrate to the corresponding `Async`-suffixed methods and await their results.
The placement readers use the SQLite worker. Internal callers use the awaited
methods; the synchronous adapters remain solely for released plugin contracts.
TypeScript marks those adapters deprecated. They retain their result shapes and
completion timing until the next Plugin SDK major and an explicitly approved
breaking release. No schema, retained data, or update migration changes.

GitHub publication's opaque requester and synchronous lifecycle methods, plus
personal OAuth `cancelAuthorization` and `disconnect`, share the
`github-publication` runtime warning budget. The personal OAuth methods retain
their synchronous results until the same removal gate; migrate to
`cancelAuthorizationAsync` and `disconnectAsync`. Follow the
[V2 request and lifecycle migration](/plugins/sdk-migration/how-to-migrate#await-github-publication-operations)
for required host capabilities and callback ordering. This does not change the
warning policy of the placement reader family.

### Channel pairing allowlists

`readChannelAllowFromStoreSync` from `openclaw/plugin-sdk/channel-pairing` is
deprecated as of October 3, 2026. Await `readChannelAllowFromStore` from the same
subpath with the same channel, environment, and optional account ID. Both APIs
shipped in OpenClaw 2026.9.8; the synchronous API keeps its signature and native
behavior until the next Plugin SDK major and explicit breaking-release approval.

The async API and bundled channel callers read current allowlist rows in the
shared-state worker. Account normalization, entry ordering, and ingress policy
gates are unchanged. A missing store returns an empty allowlist without creating
storage; boot and Doctor own initialization and migrations. Read failures
propagate to the caller, and ingress retains its fail-closed handling. Prepared
entries do not replace current message or channel authority. No schema, retention,
or update migration is required, and no runtime warning is emitted.

### Inbound envelope timestamps

Await `readSessionUpdatedAtAsync` from `openclaw/plugin-sdk/session-store-runtime`
or `runtime.channel.session.readSessionUpdatedAtAsync`. The existing session
reader captures the physical store and reads current activity in its worker.
Missing stores return `undefined` without creating or migrating a database.
Read failures propagate; there is no synchronous fallback.

From `openclaw/plugin-sdk/channel-inbound`, await
`createChannelInboundEnvelopeBuilderAsync` or `resolveInboundSessionEnvelopeContextAsync`
at the message's formatting boundary. Resolve the route through `resolveAgentRoute`
from `openclaw/plugin-sdk/routing` before preparing its envelope.
Create a fresh builder for each inbound message. Its returned formatter is
synchronous and reuses that message's prepared timestamp; `previousTimestamp: null`
still suppresses timestamps for history entries. Prepared timestamps describe
activity and never replace current channel or session authority.

The synchronous timestamp and envelope APIs shipped in OpenClaw 2026.9.8 remain
deprecated compatibility until the next Plugin SDK major and explicit breaking-release
approval. This includes the callback-based `inbound-envelope` helpers and
`dispatchInboundDirectDmWithRuntime`; bundled callers use the awaited preparation
and `dispatchInboundDirectDm`. Existing synchronous signatures and callback timing
remain unchanged. No schema, stored data, retention, or update migration is required.

### Progress card handoff

`ReplyDispatchRuntimeInfo.adoptProgressContinuation(receipt)` from
`openclaw/plugin-sdk/reply-runtime` is deprecated as of October 6, 2026. Editable
progress adapters use `adoptProgressDraft(draft)` instead: they keep the card and
its rendering, and the host pushes prepared items and retires the card once. See
[progress card handoff](/plugins/sdk-channel-plugins/status-and-media#progress-card-handoff).

The receipt type shipped in OpenClaw 2026.9.8 stays source-compatible until the
next Plugin SDK major and explicit breaking-release approval. The host never
offers it, so a published adapter that checks for it keeps ordinary waiting-reply
delivery and the host never receives a receipt. Telegram, the only bundled
adopter, uses the draft handoff. No schema, stored data, retention, or update
migration is required.

### Watched-session harness context

`buildWatchedSessionsHarnessContext` from
`openclaw/plugin-sdk/agent-harness-runtime` is deprecated as of October 3, 2026.
Await `prepareWatchedSessionsHarnessContext` from the same subpath, passing the
same prompt inputs and a required `assertCurrent` callback bound to the current
host capability and attempt cancellation. The callback must throw when that
authority is no longer current; preparation checks it before reads and again
before disclosing the prepared context.

The awaited helper reads watched-session and session-entry facts in the existing
database workers. It preserves prompt bytes, ordering, limits, tool availability,
and visibility gates, and never falls back to caller-thread database reads.
Bundled harnesses use the awaited helper. The released synchronous helper keeps
its `string | undefined` result and behavior until the next Plugin SDK major and
explicit breaking-release approval. JSDoc and the compatibility registry record
the deprecation; no runtime warning, schema migration, or update change is needed.

### Reply tool authority preparation

The October 4, 2026 `reply-tool-authority-sync-preparation` record retains the
synchronous fingerprint, projection, and binding methods reachable through
`EmbeddedRunAttemptParams.replyOperation` and `AgentHarnessAttemptParams.replyOperation`,
including their V2 types. These contracts shipped in OpenClaw 2026.9.8.
Existing snapshot literals containing only `fingerprint` and `project` remain
valid; their awaited companions are optional.

The record also retains the original V2 queue method. External implementations can add
the optional awaited queue companion described in
[awaited reply tool authority](/plugins/sdk-migration/how-to-migrate#await-reply-tool-authority).
Legacy external V2 injection backends retain fresh native policy checks; an earlier
prepared fingerprint never replaces current authority.
Supplied Talk control adapters retain fully rendered steering and follow-up input,
including prepared context and the transcript recorder, even when they ignore
optional preparation callbacks. The built-in runtime prepares that input inside
its queue reservation to preserve ordering across awaited policy reads.
Legacy V1 backends retain unbound run-owned input; caller-bound input still
requires V2. Worker preparation does not change that distinction.
Legacy ordinary queue preparation stays inside its FIFO reservation, with
synchronous final checks outside worker grants. Complete worker preparations
bind their final policy and target reads to enqueue; cleanup or notification
failure after enqueue preserves input custody and cannot authorize replay.
Question claims and cancellation retain their existing synchronous assertions,
with optional awaited companions for prepared backends.
Native session binding authorities retain their original `withCurrent` contract.
The optional `withPreparedCurrent` companion composes fresh tool policy with native
lineage admission; older authority implementations remain valid and use the full
synchronous compatibility check.

Custom question dispatchers retain their original `authority.assertCurrent`
callback and can add the optional awaited companion. Legacy external V2
dispatchers retain fresh native policy checks. Retained commit guards for
store-bound secret answers still recheck their original session owner.

Removal requires the next Plugin SDK major and explicit breaking-release
approval. TypeScript annotations and migration documentation provide diagnostics;
there is no runtime warning. Stored data, schema, retention, and update behavior
are unchanged.

### Harness attempt result migration

In OpenClaw 2026.8.1, `EmbeddedRunAttemptResult` from
`openclaw/plugin-sdk/agent-harness-runtime` requires the canonical `terminal`
field. Source written against the 2026.7 direct alias must migrate when it
constructs results with legacy fields such as `aborted`, `timedOut`, and
`promptError`; retaining the alias name does not make those old constructors
source-compatible.

Use `AgentHarnessAttemptResult` from the same subpath while migrating a
legacy result producer. That union accepts both the legacy fields and the
canonical result, and the host lifecycle normalizes legacy results before
core consumes them. New producers should construct `terminal`; consumers of
the union must narrow the result before reading it. The current
`EmbeddedRunAttemptResult` contract keeps `terminal` required.

### Session observer and progress visibility

The October 4, 2026 `session-observer-progress-sync-reads` record retains the
synchronous observer methods and progress visibility contracts shipped in
2026.9.8. `context.sessionObserver.handleEvent`, `getCompanionSnapshot`, and
`dispose` retain their synchronous signatures and completion behavior.
`PluginHookReplyDispatchEvent.shouldSendToolSummaries` remains a live boolean
getter, `shouldSendFullToolDetails` remains a dispatch-time boolean, and
`GetReplyOptions.onVerboseProgressVisibility` still receives a synchronous getter.

Core and bundled callers use the [awaited replacements](/plugins/sdk-migration/how-to-migrate#await-session-observer-and-progress-visibility).
The released ACP hook helper still accepts boolean-only events from external
callers; host-created events provide fresh awaited predicates. Deprecated native
reads remain compatibility debt until the next Plugin SDK major and explicit
breaking-release approval. JSDoc and the compatibility registry record the
deprecation without runtime warnings. Schemas, retained data, and update behavior
are unchanged.

### Mention Inbox persistence

The October 3, 2026 `mention-inbox-sync-persistence` record retains the
synchronous `mentionInbox.list(client)`, `mentionInbox.dismiss(client, ids)`,
`mentionInbox.recordCommittedInput(input)`, and `mentionInbox.invalidate(sessionKey)`
contracts exposed through the Gateway Plugin SDK context. Their result shapes,
exact-ID matching, and immediate completion remain supported until the next
Plugin SDK major and explicit breaking-release approval. Recording persists
synchronously; invalidation refreshes connected views before returning. Inside
an enclosing transaction, notifications wait for that transaction to commit.

Use `listAsync` and `dismissAsync` with their synchronous result-publication
callbacks, and await `recordCommittedInputAsync` and `invalidateAsync`; see
[awaited Mention Inbox operations](/plugins/sdk-migration/how-to-migrate#await-mention-inbox-operations).
Core and bundled callers use these worker-backed methods. Legacy calls emit one
`DEP_SESSION_PERSISTENCE` warning per plugin and capability family per process, with one
SDK-level family warning for unscoped calls. Schemas, retained data, and update
behavior are unchanged.

### Personal model-account control plane

The October 3, 2026 `model-account-connect-sync-persistence` record retains the
seven synchronous `modelAccountConnectService` methods shipped in 2026.9.8:
`listLinks`, `link`, `unlink`, `list`, `select`, `status`, and `cancel`. They remain
available through the Gateway Plugin SDK context with their existing arguments,
return envelopes, and immediate completion until the next Plugin SDK major and
explicit breaking-release approval. In particular, the released action shape
`{ owner: string; assertCurrent: () => void }` remains source-compatible.

Core and bundled callers use the corresponding `Async` methods; see
[awaited personal model-account operations](/plugins/sdk-migration/how-to-migrate#await-personal-model-account-operations).
Synchronous calls emit one `DEP_SESSION_PERSISTENCE` warning per plugin and
capability family per process; unscoped callers share one family warning. The compatibility
adapters retain native database access during this window. RPC schemas,
credential storage, retention, and update behavior are unchanged.

### Awaited session persistence

The October 1, 2026 records `session-manager-sync-persistence`,
`extension-session-sync-persistence`, and `provider-replay-sync-persistence`
retain the shipped synchronous transcript contracts as named third-party
compatibility adapters. Their removal gate is `next-plugin-sdk-major`, with no
calendar removal date. Existing exports and immediate return values remain
available while plugins migrate; synchronous SessionManager methods and their extension/provider adapters share
one warning per plugin and session-persistence family per process.

Use the [awaited session persistence migration](/plugins/sdk-migration/how-to-migrate#await-session-transcript-persistence)
for the complete method mapping, extension calls, and versioned provider replay
types. Bundled code uses the awaited contracts. File-backed writes reuse the
canonical worker writer; incognito retains its process-local owner until its
separate cutover. Schemas, persisted bytes, and supported update paths are
unchanged. Removal still requires explicit breaking-release approval.

### Reply run-start transcript facts

`GetReplyOptions.onAgentRunStart` from `openclaw/plugin-sdk/reply-runtime`, also
provided to `reply_dispatch` hooks, retains the callback shipped in OpenClaw
2026.9.8: `(runId, executionIdentityToken?, options?) => unknown`. Existing
callbacks and producers that omit later arguments remain supported. Completion
ownership still requires returning `"reply-dispatch"` synchronously.

Current runtime helpers supply prepared transcript facts in an optional fourth
argument. Wrappers should forward every argument and the callback's return value;
see [message hooks](/plugins/hooks/messages). The facts describe the transcript
boundary and do not grant session or write authority. When a released producer
omits them, the Gateway retains its synchronous transcript-read fallback.

Only that omitted-facts fallback is deprecated as of October 4, 2026; the callback
itself remains supported. The fallback stays until the next Plugin SDK major and
explicit breaking-release approval. The compatibility registry records the
migration without runtime warnings. Schemas, retained data, and update behavior
are unchanged.

### Agent execution preparation compatibility

The execution object accepted by
`openclaw/plugin-sdk/sqlite-runtime.openOpenClawAgentSqliteWorkerStore` retains the
`prepare(source, signal?) => Promise<void>` contract published in
`v2026.10.1-beta.1`. Existing callers and two-argument implementations remain
supported. The publication source also accepts the execution object shape shipped
in `v2026.9.9`. The `v2026.10.1-beta.1` shape retains its callable
`capturePreparedGenerationClaim` method in parameter-derived types; internal
native-adoption capabilities are not required from plugins. Ordinary preparation
reuses a completed native generation; host
admission can request current schema proof through an optional third argument.

The `agent-execution-preparation-released-signature` compatibility record is
active, with no deprecation warning or required migration. Breaking the released
contract requires an explicitly approved Plugin SDK major release. Schemas,
stored data, and update behavior are unchanged.

### ACP metadata binding compatibility

`openclaw/plugin-sdk/acp-runtime` retains the one-argument
`readAcpSessionEntryAsync` callable published in `v2026.9.8`. The returned ACP
manager's `loadSessionEntryAsync` and `upsertSessionMeta` injection callbacks also
keep their released one-argument signatures and Promise results. Plugins do not
supply internal incognito actor bindings.

The `acp-session-metadata-released-signatures` compatibility record is active:
these APIs remain supported, with no deprecation warning or required migration.
Worker activation must preserve them; changing these released contracts requires
an explicitly approved Plugin SDK major release.

### Memory session binding compatibility

`openclaw/plugin-sdk/memory-core-host-engine-sessions` retains the readers
published in `v2026.9.8`: `buildSessionEntry(path, options?)`,
`listSessionTranscriptCorpusEntriesForAgent(agentId, options?)`, and
`readSessionResetRecallCutoff(scope)`. Their Promise results and synchronous
`onTranscriptMessage(message, observedAt)` observer remain unchanged. Internal
incognito actor sources are not plugin arguments.

The `memory-session-released-signatures` compatibility record is active. These
APIs remain supported without warnings or a required migration; changing their
released contracts requires an explicitly approved Plugin SDK major release.

### Session upstream-link writes

`openclaw/plugin-sdk/session-catalog` retains the synchronous
`upsertSessionUpstreamLink` and `deleteSessionUpstreamLink` contracts released in
`v2026.9.8`, including their immediate return values and completion timing. The
production-private `agent-harness-session-runtime` initializer also retains its
synchronous `prepare().link(input)` method for released official harnesses.

The `session-upstream-links-sync-persistence` compatibility record deprecates
those methods without runtime warnings. Core and bundled callers await
`upsertSessionUpstreamLinkAsync`, `deleteSessionUpstreamLinkAsync`, or the
initializer's `linkAsync`. The synchronous contracts remain until the next
Plugin SDK major and explicit breaking-release approval. See
[await session upstream links](/plugins/sdk-migration/how-to-migrate#await-session-upstream-links).

### Native session generation authority

The production-private `agent-harness-session-runtime` subpath retains the
contracts consumed by official harness packages released with OpenClaw 2026.9.8.
`captureNativeSessionGenerationAuthority` still returns `state`,
`previousSessionId`, `assertHostCurrent`, and `assertCurrent` synchronously.
`resolveNativeSessionBinding` still returns `{ binding, assertCurrent }`, and
`NativeSessionGenerationOperations` keeps its two-argument `adopt` and `reclaim`
callbacks. Their supplied assertion continues to check durable session lineage
after an awaited operation.

Current harness code awaits `prepareNativeSessionGenerationAuthority`,
`resolveNativeSessionBindingWithAuthority`, or
`reclaimNativeSessionGenerationWithAuthority`. The resolver returns
`{ binding, authority }`. `NativeSessionGenerationOperationsV2` requires each
mutation callback to accept `(expectedPreviousSessionId, authority)` and carry
that authority into binding storage. Use `authority.withCurrent` for synchronous
native action admission; its ordinary `assertCurrent` checks lifecycle only.
Durable lineage reads use the session worker.

The old exports are deprecated without runtime warnings. They remain until the
next Plugin SDK major, migration of supported published official harness readers,
and explicit breaking-release approval. This preserves installed harnesses
across host upgrades without extending the private subpath into a public SDK.

### Model-provider result compatibility

`openclaw/plugin-sdk/models-provider-runtime` preserves the `ModelsProviderData`
construction shape and `buildModelsProviderData` return signature published in
`v2026.7.1-2`, including typed adapters that return that shape. These contracts
remain supported until an explicitly approved SDK-breaking boundary.

Call `buildPreparedModelsProviderData` when forwarding model selections. Its
result includes the required `modelCatalog` with
the selected physical-route metadata. Both builders use one metadata producer;
callers must carry prepared rows forward rather than reconstructing them from IDs.

Both builders return the currently published menu rows without waiting for full
discovery. Results may be partial while acquisition continues in the background;
`pendingProviders` identifies providers still refreshing. Keep known choices usable
and call the builder again when the menu is reopened. Awaiting a menu builder is
not a complete-inventory guarantee. Use the catalog's explicit refresh operation
when requesting inventory acquisition rather than treating a menu read as one.

Use `getModelsRuntimeChoices(data, provider, model)` from the same SDK subpath
for a selected model. A nonempty array contains that model's eligible runtime
choices. An empty array means the current observation permits no runtime for
that model. `undefined` means the choice is unknown: the model has no observation,
the caller supplied the older result shape, or `data.isCurrent()` reports that
the prepared owner has retired. Do not replace either result with a provider
default or a runtime inferred from its name. Refresh retired data through its
owning catalog before selecting again.

Omitting `model` returns the provider's browsing union. That union does not
authorize a runtime for every model in the provider. Pass `sessionEntry` to the
builder when browsing for a session so its profile preference, explicit profile
pin, and runtime override participate in the choices. Keep the prepared physical
row and revalidate the selection through the normal command owner; a displayed
choice is not authority to use a retired generation or bypass a session lock.

Provider plugins can publish native login presence through `prepareSyntheticAuth`
with `nativeAuth: { runtime, mode }`, where `mode` is `api-key`, `oauth`, or
`token`. These facts apply only to the named runtime in the prepared generation.
They do not supply a provider bearer credential or authorize importing one into
an OpenClaw profile. The optional `pluginRoot` context comes from the plugin
loader; use it to resolve the declared dependency from that plugin's installation.

### Memory session inventory readers

`loadArchivedSessions` and `resolveMemorySessionTargets` from
`openclaw/plugin-sdk/memory-core-host-engine-sessions` are deprecated as of
October 1, 2026. Await `loadArchivedSessionsAsync` and
`resolveMemorySessionTargetsAsync` from the same subpath. The replacements
run durable archive and selector reads in the retained session worker and
preserve selection, ordering, missing-store behavior, and result shapes.
Process-held incognito stores keep their native owner.

Bundled memory search and memory-forget use the awaited readers. The synchronous
exports retain their signatures and behavior for existing consumers until removal
at the next Plugin SDK major. Deprecation is communicated through JSDoc and the
compatibility registry, and a runtime warning once per plugin and reader family.
The retained synchronous selector can still query participant rows on the calling
thread; its awaited replacement keeps that work in the session worker.

The prepared incognito actor adapters remain inactive for ordinary unbound
calls. Under an explicit actor binding, Memory entry, reset-cutoff, corpus, and
selector reads retain that actor; a selected missing actor returns the normal
missing result, while a retained ended actor rejects. Archive discovery returns
no durable artifacts for that actor. Private transcripts are not added to the
durable Memory ingestion corpus.

The synchronous `loadMemorySessionMetadata` and
`loadMemorySessionMetadataBatch` helpers remain durable ingestion admission
guards. `statSessionEntrySync`, batch transcript stats, and synchronous archive
and selector readers retain their existing native/offline contracts. Explicitly
bound actor calls refuse synchronous database access with
`IncognitoSessionSyncAccessError`: await `resolveMemorySessionTargetsAsync`,
`loadArchivedSessionsAsync`, or `buildSessionEntry` as named by the error.
Worker snapshot kernels and supplied transcript statistics remain synchronous;
this preparation does not change production incognito selection or the
released synchronous full-row session getter.

### Memory read missing results

Memory managers now return `status: "ok"` for successful excerpts and
`status: "not_found"` when an allowed file is missing. This keeps empty files
and empty ranges distinct from missing files without relying on pagination
metadata.

At registration, every statusless result from an older external memory manager
preserves its legacy successful-read semantics and becomes `status: "ok"`,
including empty results without range metadata. Only an explicit
`status: "not_found"` reports absence. New producers must emit that status for
missing files; registered-input normalization remains available through the
next Plugin SDK major.

### Config record migrations

Use `mergeMissing(canonical, legacy)` from
`openclaw/plugin-sdk/runtime-doctor-migrations` to fill undefined fields without
replacing authored values. It fills existing nested records in place and keeps
authored arrays, nulls, and scalars. Missing values are assigned by reference;
callers own any cloning needed to isolate the migration from its input.

The helper skips undefined source values and `__proto__`, `prototype`, and
`constructor` keys at each level it merges. It does not recursively sanitize
newly assigned subtrees.

### Plugin state migration declarations

Bundled plugins should list every migration under
`doctorContract.stateMigrations` in `openclaw.plugin.json` and export the
matching `stateMigrations` array from their doctor-contract artifact. Keep the
IDs, order, `doctorOnly` flags, and phases identical. Read-only Doctor planning
uses candidate-bundled descriptors to record exact plugin owners without
loading the plugin.

Installed external plugin artifacts are not part of the copied-state or
candidate content identity. Copied-state planning refuses their migrations,
including manifests that contain descriptor arrays, until candidate validation
binds those artifacts separately. The legacy value `true` continues to locate
their dynamic contract for non-planning Doctor flows.

Plan-based migrations can use
`definePluginDoctorMigrationFromPlans(...)` from
`openclaw/plugin-sdk/runtime-doctor-migrations` to preserve existing move, copy, preview,
and plugin-state import behavior.

Migrations may supply a read-only `collectBackupResources` callback, including
through `definePluginDoctorMigrationFromPlans(...)`. Return absolute paths with
kind `sqlite`, `file`, or `directory`, including destinations that do not exist
yet. Never open a writable store or run the migration during inventory. When
`requireLocalResources` is true, reject remote or unlisted data rather than
reporting an incomplete inventory as complete.

The recovery inventory collector reports one typed
`undeclared-migration-resources` warning per plugin without a callback; its
private state is not included in the recovery set. Malformed declarations and
invalid inventories still fail. Collection does not capture or restore data,
authorize a migration, or replace an updater's required capture checks.

For single-file imports, `defineLegacyJsonStateMigration(...)` skips missing
sources (`ENOENT`) and values the plugin parser rejects with `null`. Other read
errors and invalid JSON reach Doctor's detection or migration warnings; the
source remains untouched so the operator can fix it and retry.

For a format outside the [supported upgrade window](/gateway/doctor/config-migrations#retention-policy),
use `defineRetiredPluginStateMigration({ id, label, intermediateVersion, findSources })`
from the same facade. The plugin supplies absolute candidate paths or immediate
directory selections `{ directory, prefix?, suffix }`; the helper checks existence
without parsing or changing source bytes. Missing paths are ignored; other read
errors remain failures. Doctor reports a refusal naming the intermediate release
and retained files. Supply `recoveryInstructions` when the bridge requires an
owner-specific step beyond Doctor. Its `assertSupportedState(input, sources?)` operation applies
the same check at runtime admission; a caller with an already selected file may
pass that path explicitly. Keep account and workspace discovery with the plugin.

Use `phase: "after-session-repair"` when a migration needs canonical session
ownership evidence. Ordinary Doctor detects these migrations; `--fix` applies
them after session repair under SQLite maintenance ownership. The context
provides bounded `readPluginStateEntriesInKeyRange` and
`readSessionIdentityEvidenceBatch` reads, plus
`deletePluginStateEntriesIfUnchanged` only during a fenced repair. Preserve
unknown or ambiguous ownership. Delete only the observed raw rows; callbacks
retained after maintenance ends cannot authorize later writes.

Trusted bundled and official plugins may also use the optional
`inspectCronJobs` and `repairCronJobs` context methods for explicit cron
migrations. Inspection is non-creating and returns raw definitions, row IDs,
ordering, validation findings, and store keys for every persisted partition.
`repairCronJobs(inventory, changes)` is available only during offline repair:
it saves a verified shared-state SQLite backup, rechecks current authority and
the inspected definitions, then applies all selected replacements or deletions
in one transaction. A replacement preserves the row ID, partition, ordering,
and runtime state. A deletion uses normal cron scratch and grant cleanup.
The result reports `changed` and the retained `backupPath`; a no-op creates no
backup. Plugins classify their own historical jobs and retain ambiguous rows.
Older hosts may omit these methods, so a migration must check availability.

These helpers follow the [native-plugin trust model](/plugins/architecture#execution-model):
eligible plugins run with host privileges and own historical job classification.
The host enforces installation provenance, offline repair authority, unchanged
definitions, verified backup, and atomic persistence. The API does not promise
isolation between mutually untrusted native plugins.

The setup-entry `legacyStateMigrations` option and feature flag,
`setupFeatures.legacyStateMigrations`,
`BundledChannelLegacyStateMigrationDetector`, and
`ChannelPlugin.lifecycle.detectLegacyStateMigrations` remain supported through
one doctor-pipeline adapter for external plugins, but are deprecated. Removal
plan: remove that adapter after OpenClaw 2027.1 only when a published-plugin
reader sweep finds no remaining users.

### AuthStorage SQLite migration

`AuthStorage.forAgent(agentDir)` is the canonical constructor for host session
storage. It persists provider-default credentials through the agent's
`openclaw-agent.sqlite` auth-profile rows and never creates `auth.json`.
Harness plugins receive the prepared storage instance as `params.authStorage`.

`AuthStorage.create(authPath)` remains as a named deprecated adapter for
existing plugins. The path is used only to derive the owning agent directory;
the adapter reads and writes SQLite, not the named JSON file. Migrate to
`forAgent(...)` now. The path-taking form emits
`AUTH_STORAGE_CREATE_DEPRECATED` and is eligible for removal after
2026-10-01, provided the published-plugin reader sweep is clean.

`FileAuthStorageBackend` is an internal SQLite-backed adapter, not an exported
Plugin SDK backend. It is not available as a named import from
`openclaw/plugin-sdk/agent-sessions`. Harness plugins should use the
host-prepared `params.authStorage`; host code that constructs storage should
use `AuthStorage.forAgent(agentDir)`. The internal adapter emits
`FILE_AUTH_STORAGE_BACKEND_DEPRECATED` and never reads or writes the legacy
file. Its internal deprecation window does not preserve the former SDK import.

If a manifest field is still accepted, keep using it until docs and
diagnostics say otherwise. New code should prefer the documented replacement;
existing plugins should not break during ordinary minor releases.

The dated compatibility registry also tracks shipped annotations that do not
belong to one legacy subpath. Unless a later date is listed below, these records
use 2026-10-01 as the earliest review date; removal still requires the reader
condition in the final column. The October 1 families are `removal-pending`
while those migrations remain unverified; their original dates are unchanged.

| Compatibility code                                | Replacement                                                       | Removal condition                                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `plugin-sdk-broad-runtime-barrels`                | Focused capability subpaths                                       | No bundled or published imports of the seven enumerated broad barrels remain.                                        |
| `plugin-sdk-provider-owned-helper-shims`          | Provider-local auth/model/replay/OAuth/stream APIs                | Every enumerated helper is migrated in official providers and absent from published plugins.                         |
| `message-presentation-legacy-bridges`             | `MessagePresentation` and channel presentation renderers          | Producers and official channel packages no longer emit or read legacy interactive replies.                           |
| `plugin-sdk-focused-compat-aliases`               | The focused replacement named by each `@deprecated` annotation    | Every enumerated alias has zero bundled and published readers.                                                       |
| `agent-harness-terminal-result-aliases`           | `AgentHarnessAttemptResult.terminal` and `visibleReplies`         | Harness plugins no longer read legacy terminal booleans or `sourceVisibleReplies`.                                   |
| `official-plugin-export-aliases`                  | Presentation renderers and host-owned Discord timeout behavior    | Minimum supported official plugin packages no longer import the aliases.                                             |
| `memory-host-compatibility-aliases`               | Canonical memory cache/FTS tables                                 | Supported artifacts no longer pass table overrides, and legacy table data remains preserved.                         |
| `plugin-runtime-api-compat-aliases`               | Namespaced plugin APIs and focused runtime methods                | All enumerated flat API/runtime aliases have no readers.                                                             |
| `plugin-provider-manifest-compat-aliases`         | Manifest-owned kind/setup metadata and model catalog registration | Providers no longer publish runtime kind or legacy catalog hooks.                                                    |
| `agent-harness-credential-prompt-string-argument` | Options object `{ controlToolsAvailable }`                        | Deprecated and warnings start 2026-09-09; supported through 2026-11-30. Remove after that date once callers migrate. |

The deprecated GitHub Copilot token-exchange exports have been removed from
`provider-auth`: `DEFAULT_COPILOT_API_BASE_URL`, `deriveCopilotApiBaseUrlFromToken`,
`resolveCopilotApiToken`, and `CachedCopilotToken`. The GitHub Copilot plugin owns
authentication and account endpoint resolution; provider integrations should
use their registered auth hooks instead of the retired `/v2/token` exchange.
`normalizeGithubCopilotDomain` remains available.

Update plugins that import the removed exports before updating the host. This
removal does not rewrite credentials, delete existing cache entries, or change
the current GitHub Copilot plugin's authentication flow.

The deprecated `sourceVisibleReplies` delivery default remains supported for
July 2026 `@openclaw/codex` plugins. Migrate to
[`deliveryDefaults.visibleReplies`](/plugins/sdk-agent-harness/sessions-and-results#harness-delivery-defaults).
Published-plugin checks must include supported older versions: updates can
retain an older or linked plugin package.

Eight deprecated stream and replay hook constants have been removed. Construct
the same hooks with `buildProviderStreamFamilyHooks` from `provider-stream-family`
or `buildProviderReplayFamilyHooks` from `provider-model-shared`:

| Removed constant                   | Constructor argument               |
| ---------------------------------- | ---------------------------------- |
| `GOOGLE_THINKING_STREAM_HOOKS`     | `"google-thinking"`                |
| `KILOCODE_THINKING_STREAM_HOOKS`   | `"kilocode-thinking"`              |
| `MINIMAX_FAST_MODE_STREAM_HOOKS`   | `"minimax-fast-mode"`              |
| `OPENAI_RESPONSES_STREAM_HOOKS`    | `"openai-responses-defaults"`      |
| `OPENROUTER_THINKING_STREAM_HOOKS` | `"openrouter-thinking"`            |
| `TOOL_STREAM_DEFAULT_ON_HOOKS`     | `"tool-stream-default-on"`         |
| `ANTHROPIC_BY_MODEL_REPLAY_HOOKS`  | `{ family: "anthropic-by-model" }` |
| `OPENAI_COMPATIBLE_REPLAY_HOOKS`   | `{ family: "openai-compatible" }`  |

The stream constants are removed from both `provider-stream` and
`provider-stream-family`. Update plugins that import them before updating the
host. The constructors retain their existing behavior; this removal does not
change stored config, credentials, or session data.

`MOONSHOT_THINKING_STREAM_HOOKS` remains on both stream subpaths for published
Moonshot providers. `NATIVE_ANTHROPIC_REPLAY_HOOKS` and
`PASSTHROUGH_GEMINI_REPLAY_HOOKS` remain on `provider-model-shared` for published
Anthropic Vertex and Kilocode providers. Their `2026.7.1` and `2026.7.33` through
`2026.7.35` packages still import these names. The constructors are preferred
for new code, but these aliases retain their reader-dependent removal condition.

The unused private memory-host `loadConfig` re-exports have been removed.
Memory implementations use `getRuntimeConfig` or caller-provided config;
custom-table migration behavior remains intact.

### Published channel setup compatibility

Slack, Discord, Signal, and Microsoft Teams packages published through
`2026.7.1` import channel-specific config schemas from
`openclaw/plugin-sdk/bundled-channel-config-schema`. The published Slack and
Discord packages also import `createLegacyCompatChannelDmPolicy` and
`promptLegacyChannelAllowFromForAccount` from
`openclaw/plugin-sdk/setup-runtime`.

Those exports remain available as deprecated runtime compatibility adapters.
New and republished plugins should own their config schemas and setup policy
locally, using generic primitives from `channel-config-schema` and
`setup-runtime`. The compatibility exports can be removed only after the
minimum supported published package versions no longer import them.

### Channel setup input field compatibility

`ChannelSetupInput` now keeps only the cross-channel setup envelope typed
permanently. Channel-specific fields remain typed in a deprecated compatibility
tier so existing external plugins still compile while plugin authors move those
fields into plugin-local setup input types.

OpenClaw does not ship major releases. A registry sweep on 2026-07-22 inspected
426 published out-of-tree channel plugins and removed 21 fields with no readers.
The 22 retained fields each have a known published reader. Each further field is
deleted as soon as no published plugin reads it; the retained set shrinks as
plugin authors migrate to plugin-local setup input types.

The same sweep removed 23 legacy undeclared-adapter promotion keys with no
published dependents. Six common keys and the setup-only `rooms` key remain.
That set also shrinks as published plugins declare `singleAccountKeysToMove`.

The shared type has no index signature. Plugin-owned keys can still be present
on runtime input objects; declare them in a plugin-local intersection or narrow
them through the owning plugin's setup schema.

| `code`                                  | `owner`   | `replacement`                                                                                    | Removal condition                                                     |
| --------------------------------------- | --------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `plugin-sdk-channel-setup-input-fields` | `channel` | Intersect `ChannelSetupInput` with a plugin-local type that declares the owning channel's fields | Delete a field when the published-plugin registry sweep has no reader |

The legacy undeclared-adapter promotion tier follows the same reader-driven
policy. Declare `singleAccountKeysToMove`, including an empty array when the
plugin needs no extra promotion keys, so the shared fallback can be retired one
key at a time.

#### Verifying readers

1. Page through `https://clawhub.ai/api/v1/packages?family=code-plugin&limit=100` with each `nextCursor`, and keep packages whose `categories` include `channels`.
2. Add npm candidates from `npm search --json --searchlimit=1000 "openclaw channel plugin"`. Add source-only candidates from GitHub code searches for `openclaw/plugin-sdk/channel-setup`, `openclaw/plugin-sdk/setup`, and `openclaw/plugin-sdk/core`.
3. Resolve each candidate's latest published version. Run `npm pack <package>@<version> --json --pack-destination <temp-dir>`, unpack it, and inspect shipped `dist` JavaScript and declarations for direct or destructured field reads. Download the ClawHub artifact when a package has no npm release.
4. Record package, version, field or promotion key, and matching file. A field or key is deletable only when no published plugin artifact reads it. Keep the reader names in the code comments beside the retained field and key lists synchronized with the sweep.

This is a source/type compatibility record only. The registry entry has
`removeAfter: 2026-10-01`, but setup input runtime objects and behavior are
unchanged. The date starts a review; each field remains until its published
artifact reader count is zero.

Audit the current migration queue with `pnpm plugins:boundary-report`:

| Flag                                                    | Effect                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `--summary` (or `pnpm plugins:boundary-report:summary`) | Compact counts instead of full detail.                                                             |
| `--json`                                                | Machine-readable report.                                                                           |
| `--owner <id>`                                          | Filter to one compatibility owner.                                                                 |
| `--fail-on-eligible-compat`                             | Exit non-zero for dated `deprecated` records starting at 00:00 UTC on the day after `removeAfter`. |

`pnpm plugins:boundary-report:ci` runs with the compatibility fail flag.
For dated `deprecated` records, `removeAfter` is the final compatibility day:
`2026-09-01` becomes eligible at `2026-09-02T00:00:00Z`, not at the start of
September 1. `removal-pending` records are separate: they become due for review
at 00:00 UTC on their `removeAfter` date and are reported with blockers, but do
not trigger this fail flag. Neither state authorizes automatic removal.

Deprecated records normally have an explicit `removeAfter` date. A contract
tied to a version boundary instead declares a `removalGate`;
`next-plugin-sdk-major` is an approved major-version gate, not a pending owner
decision, and is never date-eligible. A record with neither field appears as
`no-date` and remains ineligible until its owner publishes a gate. The report
displays either the date or named gate, counts local code/doc references, lists
`removal-pending` records with their blockers and surface-token reader
references, and summarizes the private memory-host SDK bridge. Those reader
references are triage signals, not published-artifact proof.

### TTS preference resolution

Await `resolveTtsPrefsPathAsync(config)` from
`openclaw/plugin-sdk/agent-runtime` or `openclaw/plugin-sdk/tts-runtime` to resolve
the machine-owned preference path through the shared-state reader. Explicit
config and environment paths retain their precedence. Host prompt, status,
command, and speech preparation carry the resolved preferences through their
existing operations instead of reopening the state store.

The released `resolveTtsPrefsPath(config)` call still returns a `string`
synchronously, but is deprecated and emits a bounded warning when it needs
legacy resolution. `buildTtsSystemPromptHint(config, agentId, options)` retains
its synchronous return value; hosts pass prepared preferences to keep it free
of state-store reads. The asynchronous `maybeApplyTtsToPayload` call continues
to prepare preferences when none are supplied.

The `tts-preferences-sync-resolution` compatibility record retains the released
signatures until the next Plugin SDK major, migration of published plugin
readers, and explicit approval of a breaking release. Preference files, stored
data, and update behavior are unchanged.

### Media legacy projection

The `media-legacy-projection` compatibility record covers the old parallel
media fields, payload builders, hook metadata aliases, and media template
names. Its approved `removeAfter` date is **2026-10-01** (two release trains
after the facts-first replacements shipped). Removal additionally requires a
clean published-plugin artifact sweep. The record is now `removal-pending`
with the original date preserved until that proof is complete.

The unused `buildChannelTurnMediaPayload` alias has been removed from
`openclaw/plugin-sdk/channel-inbound`. Its canonical
`buildChannelInboundMediaPayload` export remains available for the compatibility
window above. New ingress code should pass ordered media facts directly.

For channel ingress, replace singular/plural `MediaPath`, `MediaUrl`,
`MediaType`, `MediaPaths`, `MediaUrls`, `MediaTypes`,
`MediaTranscribedIndexes`, `MediaWorkspaceDir`, and `MediaStaged` with ordered
facts:

```ts
import { toInboundMediaFacts } from "openclaw/plugin-sdk/channel-inbound";

const media = toInboundMediaFacts([
  { path: saved.path, url: nativeUrl, contentType: saved.contentType, messageId },
]);

const ctx = finalizeInboundContext({ Body: caption, media });
```

Use `event.media` in `inbound_claim` and `message_received` hooks. If remote
media is not locally staged, use `event.originalMedia` for identity/diagnostics
and wait for `event.media`; `event.mediaStagingPending` distinguishes that
state. Do not read the deprecated singular/plural properties from
`event.metadata`.

For CLI media models, replace `{{MediaPath}}`, `{{MediaUrl}}`, `{{MediaType}}`,
and `{{MediaDir}}` with `{{AttachmentPath}}`, `{{AttachmentUrl}}`,
`{{AttachmentContentType}}`, and `{{AttachmentDir}}`. Use
`{{AttachmentIndex}}` when attachment position matters.

For local media read policy, import `getAgentScopedMediaLocalRoots(...)` or
`getAgentScopedMediaLocalRootsForSources(...)` from
`openclaw/plugin-sdk/media-local-roots`. The
`openclaw/plugin-sdk/agent-media-payload` facade and its
`buildAgentMediaPayload(...)` projection are deprecated.
