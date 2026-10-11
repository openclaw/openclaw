---
summary: "Ordered steps for moving a plugin off the removed SDK compatibility layer"
read_when:
  - You are migrating a plugin to the modern plugin SDK right now
  - You need the ordered steps for config, middleware, approval, and import changes
title: "How to migrate a plugin"
sidebarTitle: "How to migrate"
---

The ordered migration steps. Work through them in order; each step is self-contained. Part of the [Plugin SDK migration](/plugins/sdk-migration) guide.

## Use worker-owned approval requests

Use host-bound `api.runtime.gateway.request` for approval requests, reads,
history, grant operations, resolution, and waiting. Reads that expire rows are
worker operations too. The host's method classification does not enlarge the
internal principal's allowed methods. A released opaque approval commit guard
selects its native compatibility adapter before execution, preserving its
transaction-local visibility; worker failure never selects that adapter.
The adapter remains deprecated until the next Plugin SDK major.

The shared warning budget is per plugin and capability family, on legacy use.
Current effect-time authority checks remain synchronous. Schemas, stored bytes,
permissions, and update behavior are unchanged.

## Await plugin state and conversation bindings

Use `api.runtime.state.openKeyedStoreV2<T>(options)` for a data-only store bound
to the plugin runtime's lifetime. For an individual revocable action, pass its
`assertCurrent` authority as the second argument. Deferred code with an explicit
owner can use `createPluginStateKeyedStoreV2(pluginId, options, authority)` from
`openclaw/plugin-sdk/plugin-state-store-runtime`. Keep that import lazy.

The opener returns synchronously; await every operation before publishing its
result or releasing its owner. Reads and writes execute in the existing workers.
Mutation completion includes native commit and installation of committed facts.
Atomic `consume` and `registerIfAbsent` remain single worker operations.

Replace transaction-local JavaScript callbacks with observation and conditional
application:

```typescript
// Legacy: the callback executes inside a native transaction on the host.
await legacyStore.update("counter", (value) => (value ?? 0) + 1);

// Worker-owned: prepare outside the transaction and handle an explicit conflict.
const observed = await store.observe("counter");
const result = await store.compareAndApply("counter", observed.comparison, {
  operation: "update",
  action: "set",
  value: (observed.value ?? 0) + 1,
});
if (result.status === "conflict") {
  // Recompute from current observations or report the conflict to the caller.
}
```

Comparisons bind stored content and metadata, not permission or a unique binding
incarnation. The optional fourth argument accepts same-plugin conditions on
other namespace/key observations. The worker checks every condition and the
destination inside one transaction. On conflict, prepare every dependent input
again; the returned `current` describes only the destination. Never retry a
transport error, an unknown write, or an arbitrary callback. The new API does
not serialize closures or preserve transaction-local reads made by old callbacks.
For transcript callbacks, use the separate
[transcript preparation contract](/plugins/sdk-migration/how-to-migrate#await-locked-transcript-preparation),
which checks duplicates before preparation and supports explicit suppression.

For account-scoped conversation bindings, use
`createAccountScopedConversationBindingManagerV2` from
`openclaw/plugin-sdk/thread-bindings-runtime`. Await bind, touch, unbind, and
lookup methods, including lookups that expire bindings. Register custom adapters
with `registerSessionBindingAdapterV2`; the V2 interface requires asynchronous
readers and current-owner checks. The service exposes `listBySessionAsync`,
`resolveByConversationAsync`, and `touchAsync`. An async failure never selects a
synchronous fallback. External adapters remain responsible for their own
storage, currentness, and committed publication.

The original synchronous keyed stores, opaque `update`/`deleteIf` callbacks,
binding managers, and adapter registrations remain compatibility APIs. They
preserve synchronous commit-before-return and callback ordering, and are
**removed in the next Plugin SDK major** after the approved compatibility window.
Actual legacy use emits one diagnostic per plugin and capability family per
Gateway process; importing a module does not warn. Diagnostics contain the method,
replacement, and compatibility promise, without paths or stored values.

This migration changes no schema, stored format, retention, or update behavior.

When state-backed reads feed a channel, migrate its config and security adapters
to the [async channel hooks](/plugins/sdk-channel-plugins). Forward these hooks
through wrapper and setup adapters while keeping existing synchronous signatures
for older hosts.

## Migrate inspection, authorization, and approval factories

Use these async replacements when inspection or channel eligibility reads
worker-owned state:

| SDK subpath                               | Synchronous API                                    | Replacement                                             |
| ----------------------------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| `conversation-binding-inspection-runtime` | `inspectConversationBinding`                       | `inspectConversationBindingAsync`                       |
| `command-auth-native`                     | `resolveCommandAuthorization`                      | `resolveCommandAuthorizationAsync`                      |
| `approval-delivery-runtime`               | `createApproverRestrictedNativeApprovalCapability` | `createApproverRestrictedNativeApprovalCapabilityAsync` |
| `approval-handler-runtime`                | `createChannelApprovalNativeRuntimeAdapter`        | `createChannelApprovalNativeRuntimeAdapterAsync`        |
| `approval-handler-adapter-runtime`        | `createLazyChannelApprovalNativeRuntimeAdapter`    | `createLazyChannelApprovalNativeRuntimeAdapterAsync`    |

Await inspection and command authorization before consuming their results. The
approval factories still return adapters synchronously; their async eligibility
callbacks are awaited by the host. The original APIs preserve their synchronous
contracts through the next Plugin SDK major compatibility window. Use the narrow
subpaths above for new imports; broad compatibility barrels retain existing APIs
without duplicating the replacements.

## Await Gateway approval publication

Use `await context.approvalEvents.publishRequestedAsync(kind, request)` to prepare
subscriber eligibility before publishing. If an older host supplies only
`publishRequested`, select that synchronous callback before dispatch; never retry
a failed async publication through the old callback.

`publishRequested(kind, request)` retains its synchronous numeric result for
synchronous subscribers. It is deprecated and **removed in the next Plugin SDK
major**. If any subscriber requires asynchronous eligibility, the old method
throws a migration error before sending the request to any subscriber. Use the
async method for bundled native approval runtimes, whose route selection can
prepare account state in workers. Legacy publisher objects need not implement
the optional async companion.

## Workspace mutation guards

Await `api.runtime.agent.ensureAgentWorkspace({ dir, guard: { assertHost } })`.
Prepare database-derived inputs asynchronously before calling it; `assertHost`
must synchronously check current caller authority without accessing SQLite.
Core-owned recovery predicates execute on the worker's transaction connection.

The released `beforePersistentApply: () => void` option remains supported for
TypeScript and JavaScript plugins until the next Plugin SDK major. It runs on the
host once immediately before each worker mutation dispatch, outside admission
grants, and at host filesystem mutation boundaries. Throwing stops that apply.
Synchronous OpenClaw database access in the callback is allowed and deprecated;
a warning explains the timing and typed replacement once per process.

There is no compatibility break for legacy callbacks or their database reads.
The timing nuance is that the legacy check runs just before dispatch, while
`guard.assertHost` is also rechecked inside transaction and commit grants.
Prefer the typed guard for live revocation at commit. Callback errors continue
to propagate. No schema, retention, durability, or update migration is required.

## Await Mention Inbox operations

Replace synchronous `context.mentionInbox.list(client)` and
`context.mentionInbox.dismiss(client, ids)` calls with
`listAsync(client, publish)` and `dismissAsync(client, ids, publish)`.
Both methods prepare durable state in workers, then call `publish` synchronously
with the current authorized result. Send the Gateway response inside that
callback without awaiting more work:

```ts
await mentionInbox.listAsync(client, (result) => {
  respond(result.ok, result.ok ? result.value : undefined, result.ok ? undefined : result.error);
});
```

Await the returned promise before releasing request resources or starting work
that depends on the operation. Dismissal IDs retain exact-match semantics.

Replace `recordCommittedInput(input)` with `await recordCommittedInputAsync(input)`
and `invalidate(sessionKey)` with `await invalidateAsync(sessionKey)`. Await
recording before reading the resulting Inbox, and await invalidation before
depending on refreshed connected views. Recording also awaits the collaboration
writer's session involvement update before saving Inbox items. Both writes retain
their existing owners and settle before Gateway worker shutdown.

The shipped `list`, `dismiss`, `recordCommittedInput`, and `invalidate` methods
remain synchronous third-party adapters until the next Plugin SDK major and
explicit breaking-release approval. Each emits a `DEP_SESSION_PERSISTENCE`
deprecation warning once per plugin and capability family per process; calls outside a
plugin invocation warn once per method. Existing return values and completion
timing stay intact, including recording before an immediate synchronous list.
Notifications publish after the enclosing transaction commits and are discarded
on rollback. This migration changes no schema, retained data, retention, or
update behavior.

## Await personal model-account operations

The Gateway context's `modelAccountConnectService` now provides awaited
replacements for its seven synchronous storage methods. Keep the existing
arguments and await the result before publishing a response, starting dependent
work, or releasing the caller's authority:

| Synchronous method | Awaited replacement |
| ------------------ | ------------------- |
| `listLinks`        | `listLinksAsync`    |
| `link`             | `linkAsync`         |
| `unlink`           | `unlinkAsync`       |
| `list`             | `listAsync`         |
| `select`           | `selectAsync`       |
| `status`           | `statusAsync`       |
| `cancel`           | `cancelAsync`       |

Each replacement resolves to the existing result envelope. Pass the current
owner and live `assertCurrent` callback; the service rechecks authority across
awaited work and before disclosing account summaries or links. Results never
include credentials. If a write's commit outcome is unknown, do not retry it or
fall back to its synchronous counterpart.

The synchronous methods shipped in 2026.9.8 retain their arguments, immediate
return values, and completion timing until the next Plugin SDK major and
explicit breaking-release approval. Each emits one `DEP_SESSION_PERSISTENCE`
warning per plugin and capability family per process, including across plugin reloads;
unscoped calls warn once per method. Core and bundled callers use the awaited
methods. This migration changes no RPC schema, stored data, retention, or update
behavior.

## Await placement preparation

Gateway contexts provide `workerSessionPlacementService.getManyAsync` and
`retireSessionPlacementAsync`. Await their results before using placement facts,
starting dependent work, or releasing request resources. Their synchronous
counterparts shipped through the 2026.9.8 Gateway SDK and remain deprecated
compatibility methods until the next Plugin SDK major.

Startup also awaits `clearLocalTurnClaimsAfterRestartAsync` while holding the
state-directory lock, before admitting turns. The placement worker clears stale
local claims and publishes the returned records after success. An uncertain result
fails startup; the next boot can safely repeat the cleanup. Legacy synchronous retirement and
restart cleanup warn once per plugin and capability family. Bundled reset and
deletion paths await retirement; released custom Gateway contexts retain a
separately selected synchronous adapter through the compatibility window.

Use `placementStandingGrants.resolveBindingAsync`, `validateAsync`, and
`retainAsync` for node-grant preparation. `resolveAsync` combines binding and
retained-parent validation in one request. These additions are optional on the
released interface so existing custom service implementations remain compatible;
the native Gateway supplies them. Keep `consume` at the final synchronous
transport authorization boundary: earlier prepared facts do not replace current
placement, pairing, or parent-approval authority.

Device-placement demand also has an awaited
`workerPlacementDispatchService.getAdmittedDeviceSessionCountsAsync` companion.
The synchronous method keeps its released signature until the next Plugin SDK
major. These migrations change no schemas, stored data, or update behavior.

## Await reply tool authority

Harness attempt parameters from `openclaw/plugin-sdk/agent-harness-runtime`
expose an optional `replyOperation`. Await its `bindToolAuthoritySnapshotAsync`,
`projectToolAuthorityFingerprintAsync`, and `bindToolAuthorityRouteAsync` methods.
They preserve the existing inputs and resolve to `void`, `string | undefined`,
and `string`, respectively. Preparation checks current session policy and then
revalidates the original operation and concrete backend route.

Tool-authority snapshot providers can implement optional `fingerprintAsync` and
`projectAsync` companions while keeping their released synchronous methods.
Legacy two-method snapshot objects remain accepted. Do not use an earlier hash
as permission after an await: each action needs fresh preparation and current
owner authority.

V2 injection backends can add `queueMessageAsync`. It keeps the existing arguments,
replacing the synchronous assertion argument with
`{ prepareCurrent(): Promise<void>; assertCurrent(): void; compatAssertCurrent(): void }`.
Preparation alone does not authorize input after its reader has closed. When
delegating to built-in steering, forward the supplied preparation functions
unchanged so the host can bind final reads and enqueue to one admission. Native
transports can use `withPreparedCurrent` below. A sink without that consuming
boundary retains the synchronous `compatAssertCurrent()` check immediately
before its effect, outside worker grants. The host selects the awaited companion
when supplied; released external V2 implementations remain supported.

Legacy V1 backends still accept run-owned input without a separate caller-lifetime
binding. Worker policy preparation alone does not create that binding. Input
bound to a caller, operator, or source still requires V2; the host checks current
owner and policy authority before invoking an unbound legacy backend.

Native harness backends that await session-lineage admission can use the optional
`NativeSessionBindingAuthority.withPreparedCurrent(consume, preparations)` companion.
For worker-prepared policies, it reads tool policy and lineage together through
the existing session reader, then invokes the synchronous `consume` callback
while that admission is current.
Use `withCurrent` for effects without tool-policy preparation; its signature is
unchanged. Unknown or partly supported preparation providers retain full
synchronous policy, target, and lineage checks outside worker grants, with no
await before consumption. An optional per-item
`onRefused(error)` callback may return `"discarded"` only after rejecting that item;
otherwise the entire admission fails. A late compatibility refusal rejects the
entire undispatched batch, without repeating native checks or settlement callbacks.

Pending-question sinks can implement `claimPendingUserInputAnswerAsync` and
`cancelPendingUserInputAsync`, taking the same preparation object as the queue
companion. Pass it as `authority.toolAuthorityPreparation` to the shared question
functions, alongside your current backend assertion. The question owner composes
fresh policy reads with its final resolve or cancel boundary. Legacy sinks retain
their full synchronous `compatAssertCurrent` assertion; an earlier snapshot never
substitutes for current policy.

Custom question dispatchers retain `version: 2`. When source-bound authority
provides `assertCurrentAsync`, await it after transport preparation, then invoke
`assertCurrent` immediately before I/O. Older implementations that only invoke
`assertCurrent` retain the released fresh native check. A failed awaited check
must not trigger a synchronous fallback or replay a possibly accepted input.
Run-owned legacy callbacks keep a fresh native policy assertion immediately before
dispatch because their unscoped contract exposes no awaited effect boundary.

Queue-only target eligibility stays with ordinary enqueue admission; it does not add database
reads to question callbacks. Built-in ordinary steering installs input inside
its final admission and notifies subscribers after releasing that admission.

The synchronous fingerprint, projection, binding, and injection methods are deprecated under
`reply-tool-authority-sync-preparation`, with removal gated on the next Plugin
SDK major and explicit breaking-release approval. No runtime warning, schema
change, retention change, or update migration is introduced.

## Prepare session catalog identities

Use `await prepareSessionCatalogSourceActorProjector({ pluginId, sourceDomain, actors })`
from `openclaw/plugin-sdk/session-transcript-runtime` before projecting a source catalog page.
The returned synchronous projector reads only the prepared profile and verified GitHub facts.
For receiver attribution, use `await prepareSessionCatalogGitHubLinker({ participants, owners })`,
passing the page's participants and configured owner references. Its synchronous
`linkParticipant` and `resolveOwner` methods retain every verified GitHub account and
login, while source exports use only the person's primary account.
If multiple hosts prepare concurrently, retain each linker's `assertCurrent` and
invoke it before publishing a completed host or the aggregate result.
Recheck each host's snapshot lifecycle at the same publication boundary, including
hosts that do not link profile identities.

Prepare again for each page after transport work, then project and disclose without another
await. Profile changes during preparation reject the page; identity claims never grant access.
Foreign commits after the identity read do not rewrite that page's attribution snapshot;
the next unpinned page reads fresh facts. This snapshot never replaces a permission check.
Recheck the source's current sharing policy before disclosure. The existing
`runtime.agent.session.listSessionEntries` accepts optional `sessionKeys` to restrict
this final read to exact persisted keys while preserving canonical listing validation.
Selected reads include derived participants and counts by default. Guards that consume only
sharing metadata can pass `includeParticipants: false` to skip that hydration; canonical
validation remains enabled in both read-only and writable listings.
Its optional `captureSource(assertCurrent)` callback captures the admitted physical store;
invoke the supplied assertion after preparation and before the final sharing read to reject
replacement at the same path, even when session IDs were reused.

The released synchronous `createSessionCatalogSourceActorProjector` and
`createSessionCatalogGitHubLinker` signatures remain available for existing plugins;
bundled Session Share uses the awaited helpers. Schemas, stored data, retention,
permissions, and update behavior are unchanged.

## Await session upstream links

Use `upsertSessionUpstreamLinkAsync` and `deleteSessionUpstreamLinkAsync` from
`openclaw/plugin-sdk/session-catalog`. Keep the existing arguments and await
completion before binding a native session, publishing adoption, or depending on
link cleanup. The upsert resolves to a boolean; deletion resolves to `"deleted"`,
`"absent"`, `"changed"`, or `undefined`, preserving the existing result semantics.

Pass the existing `assertCommitAllowed` callback when the write depends on live
authority. It runs at worker transaction and commit admission, so it must remain
synchronous and must not query the shared-state database. An uncertain write
outcome does not authorize retrying the write or invoking its synchronous
counterpart.

Official harnesses using the production-private
`agent-harness-session-runtime` initializer should replace
`initialization.link(input)` with `await initialization.linkAsync(input)` before
calling `initialization.bind(...)`. Await rollback cleanup before releasing the
initializer's ownership.

The synchronous upsert, delete, and initializer `link` contracts shipped in
`v2026.9.8` retain their arguments, immediate results, and completion timing until
the next Plugin SDK major and explicit breaking-release approval. Their
deprecation is recorded in TypeScript and the compatibility registry without
runtime warnings. This migration changes no schema, stored data, retention, or
update behavior.

## Prepare session entry changes

Use `prepareSessionEntryPatch` or `applySessionEntryPatch` from
`openclaw/plugin-sdk/session-store-runtime`. The agent runtime exposes
`api.runtime.agent.session.prepareSessionEntryPatch` with the calling plugin's
lifetime and session ownership checks bound by the host.

```ts
// Legacy callback adapter: retained with its original transaction guard.
await patchSessionEntry({
  ...target,
  update: async (entry) => ({ displayName: await chooseTitle(entry) }),
  assertCommitAllowed: assertLegacyOwner,
});

// Prepare outside SQLite; commit only if the captured entry is unchanged.
await prepareSessionEntryPatch({
  ...target,
  prepare: async (entry) => ({ displayName: await chooseTitle(entry) }),
  authority: { kind: "host", assertCurrent: assertLiveOwner },
});

// Already prepared data needs only one worker mutation command.
await applySessionEntryPatch({
  ...target,
  expected: { sessionId, lifecycleRevision },
  patch: { displayName: title },
  preserveActivity: true,
});
```

Preparation runs once outside the database transaction. Returning `null`
suppresses the write and retains the existing result behavior. The worker checks
the exact captured entry before committing; a conflict rejects without replaying
the callback. `applySessionEntryPatch` checks its optional expected session and
lifecycle in the committing transaction; `expected: null` requires absence.
Use `fallbackEntry` when creating an absent row, and `replaceEntry: true` only
when the supplied patch is a complete replacement.

A `host` authority checks live ownership or cancellation without database access.
It is rechecked after preparation and at worker admission and commit. Pass an
existing host-provided source assertion as
`authority: { kind: "source", source }` when storage predicates are involved;
wrapping it in a database-reading callback loses its prepared-source contract.
Ordinary direct SDK CRUD retains its existing optional-authority contract.

`patchSessionEntry`, `updateSessionStoreEntry`, and the
`updateLastRoute.assertCommitAllowed` option are deprecated and will be removed
in the next Plugin SDK major. Use `updateLastRouteWithAuthority` for guarded
route updates. Legacy guards retain their original native transaction visibility.
New preparation does not serialize closures or promise that visibility. The
shared warning budget is once per plugin and session-store family per process.

`upsertSessionEntry` and `updateAmbientTranscriptWatermark` keep their names and
results; their existing reducers now execute in the owning worker. Awaited
completion includes committed-fact installation. No schema, stored-byte,
retention, or update migration is introduced.

Unbound incognito sessions retain their native owner until the incognito actor
cutover. Cross-store source assertions retain their existing native
adapter until the typed cross-store entry writer is available. These explicit
routes are not worker-only; neither route retries a failed worker mutation.

## Await locked transcript preparation

Replace `withSessionTranscriptWriteLock` with `withSessionTranscriptWrite` from
`openclaw/plugin-sdk/session-transcript-runtime`. Pass message preparation and
the host's prepared source authority in `preparation`.

The legacy form runs opaque preparation inside the native transaction:

```ts
await withSessionTranscriptWriteLock(target, async (transcript) => {
  await transcript.appendMessage({
    message,
    prepareMessageAfterIdempotencyCheck: redactMessageSync,
  });
});
```

The replacement awaits preparation outside that transaction:

```ts
await withSessionTranscriptWrite(target, async (transcript) => {
  const result = await transcript.appendMessage({
    message,
    idempotencyLookup: "scan",
    preparation: {
      prepareMessage: async (candidate) => redactMessage(candidate),
      source: sourceAuthority,
    },
  });
  if (result?.appended) {
    await transcript.publishUpdate({ messageId: result.messageId });
  }
});
```

`prepareMessage` runs outside the transaction after duplicate detection. Returning
`undefined` suppresses a fresh append. Replays retain stored bytes and skip
preparation. The owner captures the transcript version before preparation and
checks it again in the committing transaction; a change refuses the prepared
write. It does not replay preparation automatically. Keep externally visible
side effects out of preparation, and publish only from an acknowledged result.

`appendSessionTranscriptMessagesByIdentity` remains an atomic batch of
already-prepared messages. It does not accept per-message `preparation`; use the
singleton append or the write sequence when duplicate-sensitive preparation is
needed.

The new scope orders accepted operations, and each append commits independently.
For actor-bound targets, it is optimistic: callback awaits do not reserve the
actor queue. Reads capture a transcript version that later fresh appends must
still match; successful appends advance that version. A duplicate replay can
return its original receipt after another writer advances the transcript, but
the stale scope then refuses further mutations.

Durable targets retain their canonical worker writer across callback awaits;
native compatibility and unbound native incognito targets retain their native
writer queue. Their reads do not automatically impose an exact version
precondition on later appends. On every path, awaited
`prepareMessage` still captures and rechecks its own preparation snapshot before
a fresh insert, as described above. These process-local reservations do not
exclude foreign processes or direct synchronous writers.

A callback failure does not roll back earlier appends, but discards its queued
notifications. The scope joins accepted operations in call order before releasing
ownership, including when its callback fails or returns without awaiting an
append. Retained context methods reject new calls after the callback finishes.

`preparation.source` accepts the existing host-owned source assertion. Actor and
worker-backed writes prepare its exact row predicates for the owning transaction
and recheck its bounded host lifecycle guard at mutation admission and commit.
That prepared source remains held through accepted persistence. Native sequence
writes retain the source's synchronous assertion inside the transaction before
a fresh insert; they do not acquire a separate prepared-source receipt. Pass the
original source capability through wrappers with
`composeSessionTranscriptWriteAssertion`; do not replace it with an opaque
database-reading lambda. Keep its owner alive until the write scope settles.
Unprepared source callbacks cannot authorize actor-bound writes.

The scope's captured writer authority is separate from a fresh message's source.
It remains required for reads, replay, accepted-input custody, and publication.
Actor scopes retain that prepared authority and its exact predicates until all
accepted work and publication settle.

The Codex mirror equivalent is `withCodexSessionTranscriptMirrorWrite` in
`openclaw/plugin-sdk/codex-session-transcript-runtime`; it has the same semantics
and retains message-sequence receipts.

The old lock functions, `prepareMessageAfterIdempotencyCheck`, and
`beforeFreshMessageCommit` are deprecated. Durable targets keep their original
transaction ordering, with one warning per plugin for this legacy contract.
Incognito targets, including explicitly actor-bound targets, reject the legacy
form with an error naming `withSessionTranscriptWrite` and
`preparation.prepareMessage` / `preparation.source`. Removal is scheduled for the
next Plugin SDK major. `prepareMessageAfterIdempotencyCheckAsync` remains a
compatible spelling; migrate it to `preparation.prepareMessage` too.

Actor routing remains inactive unless the host explicitly selects an actor.
Ordinary unbound incognito operations retain their existing host owner. This
migration changes no schema, retention, or stored data and needs no update step.

## Await session transcript persistence

Use the awaited `SessionManager` methods from
`openclaw/plugin-sdk/agent-sessions`. Await each mutation before reading the new
view, publishing its result, starting dependent work, or releasing the session's
write authority:

```typescript
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";

const manager = await SessionManager.openAsync(target);
const entryId = await manager.appendCustomEntryAsync("plugin-checkpoint", {
  stage: "ready",
});
await manager.appendLabelChangeAsync(entryId, "Ready");
```

Here `target` is the session owner's prepared transcript target. The async calls
retain that binding and the caller's live authority across queue waits. File-backed
SQLite persistence uses the existing writer worker and per-session FIFO order.
Append and persisted tree-mutation promises resolve after the manager adopts the
committed result; failed writes reject instead of publishing an uncommitted view. Parent,
leaf, branch, idempotency, and returned-entry semantics stay with the existing
transcript owner. Handle errors before continuing; do not retry an uncertain write
by calling a synchronous method.

| Deprecated synchronous method              | Awaited replacement                             | Resolved result                                                            |
| ------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------- |
| `appendMessage`                            | `appendMessageAsync`                            | Persisted message entry ID                                                 |
| `appendMessageWithTranscriptAnchor`        | `appendMessageWithTranscriptAnchorAsync`        | Append result, including the entry ID and transcript anchor                |
| `appendCompaction`                         | `appendCompactionAsync`                         | Compaction entry ID                                                        |
| `appendResetBoundary`                      | `appendResetBoundaryAsync`                      | Reset entry ID                                                             |
| `appendCustomEntry`                        | `appendCustomEntryAsync`                        | Custom entry ID                                                            |
| `appendSessionInfo`                        | `appendSessionInfoAsync`                        | Session-info entry ID                                                      |
| `appendCustomMessageEntry`                 | `appendCustomMessageEntryAsync`                 | Custom-message entry ID                                                    |
| `appendLeafControl`                        | `appendLeafControlAsync`                        | Leaf-control record                                                        |
| `appendLabelChange`                        | `appendLabelChangeAsync`                        | Label entry ID                                                             |
| `branch`                                   | `branchAsync`                                   | `void`; prepares the selected branch                                       |
| `branchWithSummary`                        | `branchWithSummaryAsync`                        | Branch-summary entry ID                                                    |
| `removeTrailingEntries`                    | `removeTrailingEntriesAsync`                    | Number of removed entries                                                  |
| `persist`                                  | `persistAsync`                                  | Existing raw persistence result; does not add the entry to the loaded tree |
| `prepareTranscriptRewrite`                 | `prepareTranscriptRewriteAsync`                 | Prepared rewrite; await its `commit(...)` as well                          |
| `SessionManager.appendMessageToTranscript` | `SessionManager.appendMessageToTranscriptAsync` | Persisted message entry ID                                                 |

Hydration follows the same naming convention: replace `open`, `openBounded`,
`openDetachedBounded`, and `openModelContext` with their `Async` static methods;
replace `setSessionTarget` and `reloadPersistedTranscript` with their `Async`
instance methods. See [session transcript hydration](/plugins/sdk-runtime/agent#session-transcript-hydration)
for read limits, cancellation, and target-binding rules. Synchronous getters read
the prepared view. `inMemory()` and `fromEntries()` remain synchronous;
`appendModelChange`, `appendThinkingLevelChange`, and `createBranchedSession`
already return promises and keep their names.

Replace `SessionManager.readSessionContext(target, read)` with
`await SessionManager.readSessionContextAsync(target, read, { admission?, signal? })`.
This reader preserves full-fidelity messages, including storage-only fields omitted
from model context. Its consumer may return a promise; the iterator closes when
the consumer settles, and source validation must succeed before the result is
returned. A rewritten source or revoked admission rejects the read. The durable
reader retains its database owner through consumption and cleanup;
database closure revokes the read. Final acceptance uses the existing writer
FIFO and native mutation witness, including rewrites made after worker validation.
The `session-manager-sync-context-read` record deprecates the synchronous reader on
October 4, 2026, with one warning per process and removal at the next Plugin SDK
major. Its existing synchronous result remains compatible during that window.

Actor-bound incognito sessions reject the deprecated synchronous persistence and
context methods before native storage or loaded-view mutation. The error names
the awaited replacement. Production incognito remains host-owned until the atomic
worker activation; durable synchronous compatibility is unchanged. An ordinary
`resolveCurrentTurnEntryId()` only walks the loaded view; to include omitted
custom messages, await `openAsync(target)` and walk that complete view instead.

Bundled Codex history captures `captureCodexSessionContextReader(target, signal?)`
from `openclaw/plugin-sdk/codex-session-transcript-runtime` before yielding. When
an actor binding exists, await the returned reader with the same target and a
context consumer. It retains the actor through scanning, consumption, validation,
and cleanup. Without an actor binding it returns `undefined`, preserving the
existing host route. The synchronous Codex context reader and validators refuse
actor-bound access; they never reopen a native incognito database.

Plugins that project durable history in their own worker can await
`readCodexSessionContextProjection(target, project, signal?)` from the same SDK
subpath. The projection callback receives the captured target, admission, and
physical source. Pass those facts to the worker's `readCodexSessionContext`
call and return `{ value, version }`. The retained transcript reader validates
the result before returning it, keeping final version and admission checks off
the Gateway thread. The synchronous validation exports remain compatible until
the next Plugin SDK major.

`branchAsync` can hydrate missing history through the read worker before selecting
the branch. `resetLeafAsync(): Promise<void>` orders an in-memory navigation reset
with queued session writes. Neither operation writes a leaf record by itself;
the following append retains the existing branch semantics. `resetLeaf()` remains
supported synchronous in-memory navigation and is not deprecated.

The low-level `persistAsync` mirrors `persist`: it writes a supplied entry and
returns its persistence result without adding that entry to the loaded tree.
Prefer the append methods when the caller needs view adoption; otherwise await
`reloadPersistedTranscriptAsync()` before reading the resulting tree. For a
prepared rewrite, await both `prepareTranscriptRewriteAsync()` and the returned
`commit(rewrittenEntryIds)` before using the rewritten view.

User and custom messages use the worker append path, including appends with
`beforeFreshMessageCommit`; those options do not select synchronous persistence.
Incognito storage is the explicit exception: it remains with its process-local
owner until its worker cutover. Await its calls too so dependent publication
keeps the same ordering. This migration changes no transcript format, schema,
retention, or update/Doctor behavior, and needs no data conversion.

Synchronous methods remain named third-party compatibility adapters. They keep
their existing immediate return values and emit one `DeprecationWarning` per
method per process with code `DEP_SESSION_PERSISTENCE`, naming the
awaited replacement. The
`session-manager-sync-persistence` compatibility record deprecates them on
October 1, 2026, with removal at the next Plugin SDK major
(`next-plugin-sdk-major`); there is no calendar removal deadline. Bundled callers
use the awaited methods. Do not add a sync fallback when adopting the new API.

User-turn transcript recorders also provide optional
`completeProcessingAsync(outcome)` and `waitForPendingInputSettlement()` methods.
Await processing completion before publishing its outcome. Completion records
processing separately from transcript consumption; it does not append or consume
the pending input. The synchronous `completeProcessing` callback shipped in
`v2026.9.8` retains its immediate result for existing SDK consumers. The host
uses that legacy callback only when a supplied recorder has no async companion,
never after an async failure or an undefined async result.

`finishPendingInput(disposition)` still revokes prompt custody synchronously.
After calling it, await `waitForPendingInputSettlement()` when available before
releasing the turn's session admission. This joins accepted completion and
disposition writes, including each original source of a collected input. An
uncertain write outcome is preserved and must not be replayed through either
callback. These additions change no schema, retention, or update behavior.

### Await extension session changes

Extensions should await the new methods before reading or publishing their
effects:

| Deprecated method             | Awaited replacement                                | Resolved result                     |
| ----------------------------- | -------------------------------------------------- | ----------------------------------- |
| `ExtensionAPI.appendEntry`    | `ExtensionAPI.appendEntryAsync(customType, data?)` | Persisted entry ID                  |
| `ExtensionAPI.setSessionName` | `ExtensionAPI.setSessionNameAsync(name)`           | `void`                              |
| `ExtensionAPI.setLabel`       | `ExtensionAPI.setLabelAsync(entryId, label)`       | `void`; `undefined` removes a label |
| `AgentSession.setSessionName` | `AgentSession.setSessionNameAsync(name)`           | `void`                              |

The old methods retain their synchronous `void` contract for third-party
extensions. `extension-session-sync-persistence` records their deprecation and
next-Plugin-SDK-major removal gate. The added methods preserve existing source
contracts while allowing the host to await persistence failures and committed
state before continuing. Deprecated calls emit the same once-per-family
`DEP_SESSION_PERSISTENCE` warning.

Custom extension hosts should supply `ExtensionActionsV2` through
`ExtensionRunner.bindCoreAsync(...)`. Binding remains synchronous; the required
actions return promises. `ExtensionRuntimeV2` also requires those actions, while
the original `ExtensionActions`, `ExtensionRuntime`, and `bindCore(...)` contracts
remain source-compatible. `createExtensionRuntime()` retains its original return
type. A new async API called without an async host binding rejects with a
`bindCoreAsync` migration error instead of falling back to synchronous persistence.

### Await provider replay metadata

Implement `ProviderPlugin.sanitizeReplayHistoryAsync` with
`ProviderSanitizeReplayHistoryContextV2`. Its optional `sessionState` is a
`ProviderReplaySessionStateV2`; when present, it supplies the required
`appendCustomEntryAsync(customType, data): Promise<string>` capability. Await
metadata appends before returning the sanitized replay messages. The host prefers
this hook when both versions exist and does not retry a failed async hook through
the legacy one.

For Gemini replay, use `sanitizeGoogleGeminiReplayHistoryAsync(ctx)` from
`openclaw/plugin-sdk/provider-model-shared`, or the existing
`buildProviderReplayFamilyHooks(...)` builder, which supplies the awaited hook.
The synchronous `sanitizeGoogleGeminiReplayHistory`, legacy
`sanitizeReplayHistory` hook, and `ProviderReplaySessionState.appendCustomEntry`
remain third-party compatibility adapters. The original context types keep their
signatures; the V2 types add the required awaited capability. These surfaces are
recorded as `provider-replay-sync-persistence` for removal at the next Plugin SDK
major. Deprecated calls emit the same once-per-family
`DEP_SESSION_PERSISTENCE` warning. The family builder retains its
legacy hook for supported older consumers. The awaited Gemini helper propagates
metadata write failures; the legacy adapter retains its historical best-effort
metadata behavior.

## Await session observer and progress visibility

Use `await context.sessionObserver.handleEventAsync(event)` to join event
admission, `await getCompanionSnapshotAsync(sessionKey, agentId?)` for a current
companion snapshot, and `await disposeAsync()` to join accepted observer work
during shutdown. Connection visibility and removal remain synchronous.

Reply-dispatch hooks should await `event.shouldSendToolSummariesAsync()` and
`event.shouldSendFullToolDetailsAsync()` at each visibility decision. Current
hosts supply both methods; they remain optional in the original event type so
external callers can still construct released boolean-only events. Plugins that
require worker-backed visibility should report a missing capability on older
hosts rather than substitute a cached dispatch-start boolean.

Channels should register `onVerboseProgressVisibilityAsync` instead of
`onVerboseProgressVisibility`. The callback receives `() => Promise<boolean>`;
dispatch awaits registration before selecting commentary ownership. Await the
getter before rendering progress and recheck cancellation after that await.
Commentary ownership remains frozen for a turn where the existing commentary
delivery policy requires it; ordinary live visibility reads remain fresh.
When both callbacks are supplied, the async callback takes precedence.

The deprecated methods, booleans, and synchronous callback remain available
until the next Plugin SDK major and explicit breaking-release approval.

## Managed node workspace acquisition

Node-host commands should await `context.acquireManagedWorkspaceAsync(request)`
before using the returned workspace and release its lease in `finally`. The host
checks the exact invocation session before and after acquisition, releases a
late lease if the invocation closes, and keeps prepared-workspace SQLite work
off the node's event loop. Continue checking command cancellation before starting
external work.

The synchronous `context.acquireManagedWorkspace(request)` callback shipped in
2026.9.4 remains available for external plugin compatibility and is deprecated.
Its return value stays synchronous. Bundled commands use the async companion;
plugins requiring that companion should report an unavailable host capability
instead of falling back to synchronous acquisition. Removal of the deprecated
callback requires an explicitly approved future breaking Plugin SDK release.
The `next-plugin-sdk-major` gate does not itself authorize removal or shorten
an existing compatibility window.

## Migrate durable ingress files through Doctor

Keep legacy file readers in the plugin's `PluginDoctorStateMigration`, exposed
through its Doctor contract. Declare source directories and the destination
database in `collectBackupResources`; detection remains read-only. Runtime
consumers use canonical SQLite ingress queues.

During repair, trusted channel plugins receive channel-bound access through
`context.channelIngressQueues`. Require `assertCurrent` and
`importLegacyEntries` before changing state; these capabilities expire when the
repair section ends. Use `backupLegacyStateSource({ filePath, assertCurrent })`
from `openclaw/plugin-sdk/runtime-doctor-migrations` before parsing or normalizing
the source. It preserves exact bytes in a private, durable `.migrated` file
(or a numbered successor), verifies source identity, and returns the snapshot
plus guarded source cleanup.
During discovery, normalize interrupted claim filenames with
`resolveLegacyMigrationSourcePath`, deduplicate the original paths, and pass each
source's discovered `claimPaths` to the backup helper. It restores interrupted
claims through the shared migration owner before
capturing its snapshot; receipts always use the original source path.

Call `importLegacyEntries({ accountId, entries })` with canonical channel/account
identities. Each item contains an `entry` and `sources`, whose records contain
`sourcePath`, `sha256`, and `size` from the backed-up snapshots. The host commits
pending entries or payload-free failed tombstones together with source receipts
in the existing migration ledger. Equivalent rows and completed work remain
authoritative; conflicting rows receive no completed receipt and keep their
source files. Receipts suppress repeat imports even after queue rows are consumed
or pruned. Changed source bytes form a distinct source generation.
Historical receipt and failure timestamps are preserved. Imported rows start
their mutation age at import time so pending-row pruning cannot discard old
updates before their first replay.

After a successful import or confirmed prior receipt, call
`backup.removeSource(() => { result.markSourcesRemoved([backup.snapshot.sourcePath]); })`.
The shared owner claims the original name, records its removal, then removes the
claim. A failed bookkeeping operation keeps a discoverable source for the next
Doctor pass. The callback must be synchronous. Preserve backups
and report unresolved conflicts with `openclaw doctor --fix` recovery guidance.
After a confirmed commit, cleanup-only failures may return
`warningDisposition: "recoverable"` when current repair authority and retained
source/backup identities still verify. Conflicts, lost authority, and uncertain
imports remain refusals.
Do not implement import as runtime `enqueue` followed by `fail`: an interruption
would expose a historical failure as new pending work.

## Agent roster config

Author agent rosters as `agents.entries`, keyed by agent ID. Entries contain no
`id` field or `default` marker; their insertion order is the roster order. Read
`cfg.agents.entries` directly, or use `listAgentIds` and `resolveAgentConfig` from
`openclaw/plugin-sdk/agent-runtime`. Select the owner explicitly for the surface
you use, such as `agents.defaults.systemAgent.agentId` for system work.

Authored `agents.list` and boolean entry `default` markers are rejected. Run
`openclaw doctor --fix` to migrate stored legacy configs; Doctor also records
explicit ownership for migrated multi-agent rosters.

Entries also carry no `agentRuntime` or `compaction`. Validation rejects both, so
the authored config type omits them and `resolveAgentConfig` no longer returns
`agentRuntime`. Read runtime policy from per-model `models[ref].agentRuntime` and
compaction settings from `agents.defaults.compaction`.

`agents.defaults` also no longer types `imageGenerationModel`, `videoGenerationModel`,
`musicGenerationModel`, `envelopeTimezone`, `envelopeTimestamp`, `envelopeElapsed`,
`timeFormat`, `promptOverlays`, or `agentRuntime`; validation rejects all nine. Use
`mediaModels.image`, `mediaModels.video`, and `mediaModels.music`, `userTimezone` with
built-in envelope and time formatting, `plugins.entries.openai.config.personality`,
and per-model `models[ref].agentRuntime`. This is a type-only SDK change; run
`openclaw doctor --fix` to migrate stored configs. A stored `agents.defaults.agentRuntime`
is a retired format that current Doctor refuses;
[upgrade through OpenClaw 2026.9.5](/install/updating#upgrading-very-old-versions) first.

Plugins built against stable SDK releases through 2026.9.x may still read the
deprecated, non-enumerable runtime `agents.list` projection introduced in
[#113146](https://github.com/openclaw/openclaw/pull/113146). It is no longer typed
or read internally, is not serialized or copied by `structuredClone`, and is
scheduled for removal after January 2, 2027. Config mutation drafts must read and
write `agents.entries`. This compatibility window adds no runtime warnings.

## How to migrate

<Steps>
  <Step title="Migrate runtime config load/write helpers">
    Bundled plugins should stop calling `api.runtime.config.loadConfig()` and
    `api.runtime.config.writeConfigFile(...)` directly. Prefer config already
    passed into the active call path. Long-lived handlers that need the
    current process snapshot can use `api.runtime.config.current()`. Long-lived
    agent tools should read `ctx.getRuntimeConfig()` inside `execute` so a tool
    created before a config write still sees the refreshed config.

    Config writes go through the transactional helper with an explicit
    after-write policy:

    ```typescript
    await api.runtime.config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate(draft) {
        draft.plugins ??= {};
      },
    });
    ```

    Use `afterWrite: { mode: "restart", reason: "..." }` when the change needs
    a clean gateway restart, and `afterWrite: { mode: "none", reason: "..." }`
    only when the caller owns the follow-up and deliberately suppresses the
    reload planner. Mutation results include a typed `followUp` summary for
    tests and logging; the gateway remains responsible for applying or
    scheduling the restart.

    `loadConfig` and `writeConfigFile` have been removed from the plugin
    runtime. Bundled plugins and repo runtime code are guarded by
    `pnpm check:deprecated-api-usage` and
    `pnpm check:no-runtime-action-load-config`: new production plugin usage
    fails outright, direct config writes fail, gateway server methods must use
    the request runtime snapshot, runtime channel send/action/client helpers
    must receive config from their boundary, and long-lived runtime modules
    allow zero ambient `loadConfig()` calls.

    The broad `openclaw/plugin-sdk/config-runtime` barrel has been removed.
    Use the narrow subpath for the job:

    | Need | Import |
    | --- | --- |
    | Config types such as `OpenClawConfig` | `openclaw/plugin-sdk/config-contracts` |
    | Plugin-entry config lookup | `api.pluginConfig` |
    | Config merging | Plugin-local logic at the config boundary |
    | Current runtime snapshot reads | `openclaw/plugin-sdk/runtime-config-snapshot` |
    | Config writes | `openclaw/plugin-sdk/config-mutation` |
    | Session store helpers | `openclaw/plugin-sdk/session-store-runtime` |
    | Markdown table config | `api.runtime.channel.text.resolveMarkdownTableMode` |
    | Channel group policy, mention requirements, and sender tool policy | `openclaw/plugin-sdk/channel-policy` |
    | Provider-default group-policy fallback helpers | `openclaw/plugin-sdk/runtime-group-policy` |
    | Secret input resolution | `openclaw/plugin-sdk/secret-input-runtime` |
    | Model/session overrides | `openclaw/plugin-sdk/model-session-runtime` |

    `api.pluginConfig` is registration-scoped, not a live getter. Replacing
    `resolveLivePluginConfigObject(...)` requires preserving freshness through
    the current config supplied by the runtime boundary. The injected markdown
    resolver preserves channel/account precedence and channel defaults;
    `markdown-table-runtime` is a private, JavaScript-only host export.

    The named types `TtsMode`, `TtsPersonaConfig`, `TtsPersonaFallbackPolicy`,
    and `SessionResetMode` move unchanged to `config-contracts`. Talk config,
    cron-store operations, context-visibility config resolution, and
    dangerous-name checks lack a complete modern typed-public mapping.
    Adapt plugin-owned behavior or request a focused
    public contract; do not import the private host implementation.

    Bundled plugins and their tests are scanner-guarded against the broad
    barrel so imports and mocks stay local to the behavior they need.

  </Step>

  <Step title="Migrate embedded tool-result extensions to middleware">
    Bundled plugins must replace embedded-runner-only
    `api.registerEmbeddedExtensionFactory(...)` tool-result handlers with
    runtime-neutral middleware:

    ```typescript
    // OpenClaw runtime tools and Codex runtime dynamic tools (result may be
    // transformed). Codex-native tool results are also relayed for observation,
    // but their transformed output never reaches the model: the Codex
    // PostToolUse hook contract cannot replace a native tool response.
    api.registerAgentToolResultMiddleware(async (event) => {
      return compactToolResult(event);
    }, {
      runtimes: ["openclaw", "codex"],
    });
    ```

    Update the plugin manifest at the same time:

    ```json
    {
      "contracts": {
        "agentToolResultMiddleware": ["openclaw", "codex"]
      }
    }
    ```

    Installed plugins can also register tool-result middleware when explicitly
    enabled and every targeted runtime is declared in
    `contracts.agentToolResultMiddleware`. Undeclared installed middleware
    registrations are rejected.

  </Step>

  <Step title="Migrate approval-native handlers to capability facts">
    Approval-capable channel plugins expose native approval behavior through
    `approvalCapability.nativeRuntime` plus the shared runtime-context
    registry:

    - Replace `approvalCapability.handler.loadRuntime(...)` with
      `approvalCapability.nativeRuntime`.
    - Move approval-specific auth/delivery off legacy `plugin.auth` /
      `plugin.approvals` wiring and onto `approvalCapability`.
    - `ChannelPlugin.approvals` has been removed from the public
      channel-plugin contract; move delivery/native/render fields onto
      `approvalCapability`.
    - `plugin.auth` remains for channel login/logout flows only; core no
      longer reads approval auth hooks there.
    - Register channel-owned runtime objects (clients, tokens, Bolt apps)
      through `openclaw/plugin-sdk/channel-runtime-context`.
    - Do not send plugin-owned reroute notices from native approval handlers;
      core owns routed-elsewhere notices from actual delivery results.
    - When passing `channelRuntime` into `createChannelManager(...)`, provide a
      real `createPluginRuntime().channel` surface - partial stubs are
      rejected.

    See [Channel Plugins](/plugins/sdk-channel-plugins) for the current
    approval capability layout.

  </Step>

  <Step title="Audit Windows wrapper fallback behavior">
    If your plugin uses `openclaw/plugin-sdk/windows-spawn`, unresolved Windows
    `.cmd`/`.bat` wrappers now fail closed unless you explicitly pass
    `allowShellFallback: true`:

    ```typescript
    // Before
    const program = applyWindowsSpawnProgramPolicy({ candidate });

    // After
    const program = applyWindowsSpawnProgramPolicy({
      candidate,
      // Only set this for trusted compatibility callers that intentionally
      // accept shell-mediated fallback.
      allowShellFallback: true,
    });
    ```

    If your caller does not intentionally rely on shell fallback, do not set
    `allowShellFallback` and handle the thrown error instead.

  </Step>

  <Step title="Find deprecated imports">
    ```bash
    grep -r "plugin-sdk/compat" my-plugin/
    grep -r "plugin-sdk/infra-runtime" my-plugin/
    grep -r "plugin-sdk/config-runtime" my-plugin/
    grep -r "plugin-sdk/channel-lifecycle" my-plugin/
    grep -r "plugin-sdk/channel-message" my-plugin/
    grep -r "plugin-sdk/channel-reply-pipeline" my-plugin/
    grep -r "openclaw/extension-api" my-plugin/
    ```
  </Step>

  <Step title="Replace with focused imports">
    Check the exported name and typed-public contract as well as the import
    path. Some functions are renamed; not every removed helper or named type
    has a modern public replacement:

    ```typescript
    // Before (deprecated backwards-compatibility layer)
    import {
      createChannelReplyPipeline,
      createPluginRuntimeStore,
    } from "openclaw/plugin-sdk/compat";

    // After (modern focused imports)
    import {
      createChannelMessageReplyPipeline as createChannelReplyPipeline,
    } from "openclaw/plugin-sdk/channel-outbound";
    import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
    ```

    The explicit alias preserves existing `createChannelReplyPipeline(...)`
    call sites. The modern export is `createChannelMessageReplyPipeline`;
    see [Removed channel facade mappings](/plugins/sdk-migration/import-paths#retained-channel-facade-mappings)
    for the remaining functions and named types.

    For host-side helpers, use the injected plugin runtime instead of
    importing directly:

    ```typescript
    // Before (deprecated extension-api bridge)
    import { runEmbeddedAgent } from "openclaw/extension-api";
    const result = await runEmbeddedAgent({ sessionId, prompt });

    // After (injected runtime)
    const result = await api.runtime.agent.runEmbeddedAgent({ sessionId, prompt });
    ```

    Same pattern for other legacy bridge helpers:

    | Old import | Modern equivalent |
    | --- | --- |
    | `resolveAgentDir` | `api.runtime.agent.resolveAgentDir` |
    | `resolveAgentWorkspaceDir` | `api.runtime.agent.resolveAgentWorkspaceDir` |
    | `resolveAgentIdentity` | `api.runtime.agent.resolveAgentIdentity` |
    | `resolveThinkingDefault` | `api.runtime.agent.resolveThinkingDefault` |
    | `resolveAgentTimeoutMs` | `api.runtime.agent.resolveAgentTimeoutMs` |
    | `ensureAgentWorkspace` | `api.runtime.agent.ensureAgentWorkspace` |
    | session store helpers | `api.runtime.agent.session.*` |

  </Step>

  <Step title="Replace broad infra-runtime imports">
    `openclaw/plugin-sdk/infra-runtime` has been removed. Use the supported
    surface for each operation:

    | Need | Typed-public import or injected API |
    | --- | --- |
    | New system event producers | `api.runtime.system.enqueueSystemEvent` |
    | System event snapshot inspection and consumption | `openclaw/plugin-sdk/system-event-runtime` |
    | Heartbeat wake requests | `api.runtime.system.requestHeartbeat` |
    | Channel activity telemetry | `api.runtime.channel.activity.record` and `.get` |
    | `createDedupeCache`, `resolveGlobalDedupeCache` | `openclaw/plugin-sdk/dedupe-runtime` |
    | Safe local-file/media paths, regular-file checks, and symlink-parent checks | `openclaw/plugin-sdk/security-runtime` (itself a deprecated broad barrel) |
    | `fetchWithSsrFGuard`, pinned-dispatcher helpers, `LookupFn`, `SsrFPolicy` | `openclaw/plugin-sdk/ssrf-runtime` |
    | Approval request/resolution types | `openclaw/plugin-sdk/approval-runtime` |
    | Approval reply payload and command helpers | `openclaw/plugin-sdk/approval-reply-runtime` |
    | `collectErrorGraphCandidates`, `extractErrorCode`, `formatErrorMessage`, `formatUncaughtError`, `readErrorName`, `toErrorObject` | `openclaw/plugin-sdk/error-runtime` |
    | `generateSecureToken`, `generateSecureUuid` | `openclaw/plugin-sdk/core` |
    | `parseFiniteNumber`, `parseStrictFiniteNumber`, `parseStrictInteger`, `parseStrictNonNegativeInteger`, `parseStrictPositiveInteger` | `openclaw/plugin-sdk/string-coerce-runtime` |

    OpenClaw no longer uses `commandRequiresSecurityAuditSuppressionApproval`
    internally: suppression reads and writes follow ordinary exec policy. The
    SDK export was removed with the compatibility barrel. Remove this call when
    adopting ordinary exec policy; there is no replacement command-text detector.

    These are symbol-specific mappings, not replacements for the whole barrel.
    Private-local entries such as `heartbeat-runtime`, `delivery-queue-runtime`,
    `fetch-runtime`, `runtime-fetch`, and `file-lock` are JavaScript-only host
    exports, not typed third-party APIs. Heartbeat event/summary/visibility
    helpers, pending-delivery drain, transport readiness, concurrency, and file
    locking do not have equivalent modern typed-public mappings here. Adapt
    plugin-owned behavior or request a focused public contract for the missing
    host capability.

    `fetchWithSsrFGuard` is not a drop-in replacement for dispatcher-aware fetch:
    it takes an options object and returns `{ response, finalUrl, release, ... }`,
    not a bare `Response`; callers must release its resources. The named types
    `PinnedDispatcherPolicy`, `GuardedFetchOptions`, and `GuardedFetchResult`
    are not exported by `ssrf-runtime`. Similarly, `dedupe-runtime` does not
    export the legacy `DedupeCache` or `DedupeCacheOptions` names. Migrate type
    usage explicitly rather than assuming a function move also moves its types.

    The error mapping does not cover `hasErrnoCode`, `isErrno`,
    `stringifyNonErrorCause`, `ErrorKind`, or `detectErrorKind`; the last helper
    preserves legacy substring classification. The numeric and random mappings
    likewise do not cover every timer, expiry, hex, fraction, or integer helper.
    Adapt those operations explicitly; the removed imports no longer load.

    Import system event snapshot inspection and consume helpers from
    `openclaw/plugin-sdk/system-event-runtime`: use `peekSystemEventEntries`
    to inspect and `consumeSelectedSystemEventEntries` to consume selected
    snapshots. Replace the legacy `consumeSystemEventEntries` alias with
    `consumeSelectedSystemEventEntries`. Current snapshots carry an
    opaque `id` for one queued occurrence. Preserve it through copies and
    serialization when returning a snapshot to consume. Legacy ID-less callers
    retain structural matching, which can be ambiguous after queue churn. Do
    not treat the ID as persistent or valid across restarts.

    File-lock nesting is owner-scoped. Pass the same `reentrantOwner` only for
    nested acquisitions in one logical operation; omit it for ordinary locking.
    Never use a process-wide constant, because unrelated work would incorrectly
    share the critical section.

    Bundled plugins are scanner-guarded against `infra-runtime`, so repo code
    cannot regress to the broad barrel.

  </Step>

  <Step title="Migrate channel route helpers">
    New channel route code uses `openclaw/plugin-sdk/channel-route`. The older
    route-key names remain as compatibility aliases:

    | Old helper | Modern helper |
    | --- | --- |
    | `channelRouteIdentityKey(...)` | `channelRouteDedupeKey(...)` |
    | `channelRouteKey(...)` | `channelRouteCompactKey(...)` |

    The modern route helpers normalize `{ channel, to, accountId, threadId }`
    consistently across native approvals, reply suppression, inbound dedupe,
    cron delivery, and session routing.

    Channel plugins use `messaging.targetResolver.resolveTarget(...)` for target-id normalization
    and directory-miss fallback,
    `messaging.inferTargetChatType(...)` when core needs an early peer kind,
    and `messaging.resolveOutboundSessionRoute(...)` for provider-native
    session and thread identity.

  </Step>

  <Step title="Build and test">
    ```bash
    pnpm build
    pnpm test my-plugin/
    ```
  </Step>
</Steps>

## Await strict transcript message preparation

For `appendSessionTranscriptMessageByIdentityStrict` and
`appendSessionTranscriptMessageByIdentity`, use `preparation.prepareMessage` for
awaited preparation after duplicate detection and `preparation.source` for the
host owner's source authority. They use the same
[preparation and conflict semantics](/plugins/sdk-migration/how-to-migrate#await-locked-transcript-preparation)
as `withSessionTranscriptWrite`. Strict appends still require an exact session ID
and distinguish suppression from a session rebound.

The released synchronous preparation and before-commit callbacks retain their
durable-target behavior through the next Plugin SDK major, with a one-time
warning per plugin. They are refused for incognito and actor-bound targets.
No stored data migration or update step is required.
