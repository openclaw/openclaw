---
summary: "Config snapshot, SQLite-backed plugin state, system utilities, events, and logging"
read_when:
  - You need durable keyed or blob storage scoped to your plugin
  - You maintain a bundled or official plugin that writes through per-agent SQLite handles
  - You are buffering channel ingress across restarts
  - You need the config snapshot, system utilities, events, or a scoped logger
title: "Plugin runtime state and system"
sidebarTitle: "State and system"
---

The runtime config snapshot, durable plugin-scoped storage, system utilities, event subscriptions, and logging. Part of the [Plugin runtime helpers](/plugins/sdk-runtime) reference; [Config and utilities](/plugins/sdk-runtime/config-and-utilities#config-loading-and-writes) covers the wider config read and write guidance.

## State, config, and system namespaces

<AccordionGroup>
  <Accordion title="api.runtime.config">
    Current runtime config snapshot and transactional config writes. Prefer
    config that was already passed into the active call path; use
    `current()` only when the handler needs the process snapshot directly.

    ```typescript
    const cfg = api.runtime.config.current();
    await api.runtime.config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate(draft) {
        draft.plugins ??= {};
      },
    });
    ```

    `mutateConfigFile(...)` and `replaceConfigFile(...)` return a `followUp`
    value, for example `{ mode: "restart", requiresRestart: true, reason }`,
    which records the writer intent without taking restart control away from the
    gateway.

  </Accordion>
  <Accordion title="api.runtime.system">
    System-level utilities.

    ```typescript
    const accepted = api.runtime.system.enqueueSystemEvent(text, options);
    api.runtime.system.requestHeartbeat({
      source: "other",
      intent: "event",
      reason: "plugin-event",
    });
    api.runtime.system.requestHeartbeatNow({ reason: "plugin-event" }); // Deprecated compatibility alias.
    const heartbeatResult = await api.runtime.system.runHeartbeatOnce({
      reason: "plugin-triggered-check",
    });
    const output = await api.runtime.system.runCommandWithTimeout(cmd, args, opts);
    const hint = api.runtime.system.formatNativeDependencyHint(pkg);
    ```

    `requestHeartbeatNow(...)` is tracked as `plugin-runtime-api-compat-aliases` in the [compatibility registry](/plugins/compatibility#current-compatibility-areas) with a `removeAfter` date of 2026-10-01; use `requestHeartbeat({ source, intent, reason })` in new code.

    The `openclaw/plugin-sdk/system-event-runtime` helpers resolve legacy session
    aliases at the SDK boundary. Pass a resolved `agentId` alongside `sessionKey`
    to `api.runtime.system.enqueueSystemEvent(...)` to retain the plugin runtime's
    lifecycle checks. Standalone callers can use
    `enqueueRoutedSystemEvent(text, { agentId, sessionKey })`. Read the same owner's
    events with `peekSystemEventEntries(sessionKey, agentId)`; this keeps `global`
    queues separate for each agent. Calls without an explicit owner retain
    configured-owner alias resolution and reject ambiguous agent selection.
    Explicit owners that cannot normalize to an agent ID are rejected.

    `runHeartbeatOnce(...)` runs a single heartbeat cycle immediately, bypassing the normal coalesce timer. Delivery defaults to the configured operator DM (`commands.ownerAllowFrom`, then channel `allowFrom`); pass `{ heartbeat: { target: "none" } }` for an internal-only run.

    `runCommandWithTimeout(...)` returns captured `stdout` and `stderr`, optional
    truncation counts, `code`, `signal`, `killed`, `termination`, and
    `noOutputTimedOut`. Timeout and no-output-timeout results report `code: 124`
    when the child process does not provide a non-zero exit code. Non-timeout
    signal exits can still return `code: null`, so use `termination` and
    `noOutputTimedOut` to distinguish timeout reasons.

  </Accordion>
  <Accordion title="api.runtime.events">
    Event subscriptions.

    ```typescript
    api.runtime.events.onAgentEvent((event) => {
      /* ... */
    });
    api.runtime.events.onSessionTranscriptUpdate((update) => {
      /* ... */
    });
    ```

  </Accordion>
  <Accordion title="api.runtime.logging">
    Logging.

    Generate private transport tokens with `generateSecureToken({ bytes: 32, redact: true })`
    from `openclaw/plugin-sdk/secure-random-runtime`. The object form requires at least
    16 random bytes and registers the generated value for exact diagnostic redaction
    before returning it. Existing numeric calls keep their ordinary ID behavior.
    This grants no credential access or request authority; preserve live protocol
    values and redact only at presentation boundaries.

    ```typescript
    const verbose = api.runtime.logging.shouldLogVerbose();
    const childLogger = api.runtime.logging.getChildLogger({ plugin: "my-plugin" }, { level: "debug" });
    ```

  </Accordion>
  <Accordion title="api.runtime.state">
    State directory resolution and SQLite-backed keyed storage.

    ```typescript
    const stateDir = api.runtime.state.resolveStateDir(process.env);
    const store = api.runtime.state.openKeyedStore<MyRecord>({
      namespace: "my-feature",
      maxEntries: 200,
      defaultTtlMs: 15 * 60_000,
    });

    await store.register("key-1", { value: "hello" });
    const claimed = await store.registerIfAbsent("dedupe-key", { value: "first" });
    const value = await store.lookup("key-1");
    await store.consume("key-1");
    await store.clear();

    const blobs = api.runtime.state.openBlobStore<MyBlobMetadata>({
      namespace: "rendered-artifacts",
      maxEntries: 100,
      maxBytesPerEntry: 4 * 1024 * 1024,
      maxBytesPerNamespace: 64 * 1024 * 1024,
      defaultTtlMs: 15 * 60_000,
    });
    await blobs.register(
      "artifact-1",
      new TextEncoder().encode("binary or text payload"),
      { contentType: "text/plain" },
    );
    const blob = await blobs.lookup("artifact-1");
    ```

    For command-owned writes, `store.register(key, value, { assertCurrent })`
    and `store.delete(key, { assertCurrent })` carry the captured owner assertion
    through worker preparation and admission. The assertion remains in the host;
    it is never serialized into stored data. Revocation prevents a pending write
    from being admitted, while a write already accepted by the worker still
    settles normally.

    Keyed stores survive restarts and are isolated by the runtime-bound plugin id. Use `registerIfAbsent(...)` for atomic dedupe claims: it returns `true` when the key was missing or expired and registered, or `false` when a live value already exists without overwriting its value, creation time, or TTL. Use `observe(...)` with `compareAndApply(...)` when a mutation depends on the current value; the comparison and mutation run in one SQLite worker transaction. Each namespace owns its `maxEntries` retention policy and optional TTL expiry; there is no aggregate row limit across a plugin’s namespaces. JSON values are limited to 1 MiB of UTF-8 encoded JSON. By default, a write over `maxEntries` sheds the oldest live rows only from that namespace. Set `overflowPolicy: "reject-new"` for durable ownership records that must never be evicted: new keys fail at the namespace limit, while existing keys remain updateable. Growth in a sibling cache cannot reject or evict those ownership records. Existing databases need no migration or cleanup when upgrading; their stored rows are preserved.

    To retain records without count-based eviction, use the async opener with `retention: "retained"` instead of `maxEntries`:

    ```typescript
    const history = api.runtime.state.openKeyedStore<MyRecord>({
      namespace: "conversation-history",
      retention: "retained",
    });
    await history.register("room-a:0000000042", { value: "hello" });
    ```

    `OpenKeyedStoreOptions` remains the bounded option type. `OpenRetainedKeyedStoreOptions` describes retained settings, and `OpenAsyncKeyedStoreOptions` is the async opener's union. Synchronous openers accept bounded settings only.

    Retained stores use the existing SQLite table under an internal `@retained.` namespace prefix, which cannot collide with a valid caller-supplied namespace. They do not consume bounded-store row quotas. They reject `maxEntries`, `overflowPolicy`, default TTL, and per-write TTL; records remain until explicitly deleted or cleared. The per-value JSON limit still applies, and the plugin owns disk growth and deletion policy. Caller-supplied namespaces keep their existing validation and length limits.

    `entriesInKeyRange({ keyStartInclusive, keyEndExclusive, limit, order })` reads a lexical key range, including the lower bound and excluding the upper bound. `limit` must be a positive safe integer; `order` is `"asc"` by default or `"desc"`. Storage applies ordering and the limit before returning values. Encode sortable keys when native identifiers do not sort lexically. Use bounded pages rather than `entries()` to read a growing retained store.

    `moveEntriesFrom({ namespace, entries: [{ sourceKey, targetKey }] })` promotes at most 10,000 rows from a bounded namespace owned by the same plugin into the receiving retained store. One transaction rereads and moves the source records without decoding or rewriting their payloads. Existing destination records win, missing source records are no-ops, and a retry after a completed move is idempotent. Live source records with TTL reject the whole operation; expired records are not revived. The returned number counts settled source rows. This operation does not create another table or require a Doctor step.

    These two methods remain optional in the public store type for existing adapters. A plugin using retained storage must require the host capabilities it needs; do not silently fall back to an evicting store or retry failed reads through a different path. Retained runtime handles reject operations after their owning capability closes.

    <Warning>
    Retained storage does not add a database-version fence. Older OpenClaw binaries still apply older cache and plugin-quota rules and must not write to expanded retained state. Before downgrading, restore a compatible pre-update backup; matching SQLite schema versions alone do not establish safe retention behavior.
    </Warning>

    `lookupMany(keys)` is an optional keyed-store capability for at most 10,000 exact keys per call. Results have the same length and order as the input, including duplicates. Each position is a `Result<T | undefined, PluginStateStoreError>`: `{ ok: true, value }` on success, including `value: undefined` for missing or expired keys, or `{ ok: false, error }` for corrupt stored JSON. An empty request returns `[]`. Keys use the same trimming and 512-byte UTF-8 limit as `lookup`; invalid keys or an oversized request fail with `PLUGIN_STATE_INVALID_INPUT` and operation `lookup` before reading. Database acquisition and query errors fail the whole call. Corrupt-JSON errors retain the `lookup` error code and operation in their per-key result. Inspect each result only when the reader reaches that position, and throw `result.error` if it is not `ok`; this lets a reader stop at an earlier missing or invalid chunk without raising a later corruption error. Each call uses one expiry cutoff and one SQLite selection in the same plugin and namespace, without creating a missing database. Separate calls, including metadata reads, do not share a snapshot; chunked formats must retain their generation, digest, and reader-lifetime checks.

    Current host factories provide `lookupMany`, but the public store types keep it optional for existing third-party adapters and declared older host versions. A plugin supporting those hosts must check the method and use its existing sequential `lookup` path when absent; never retry a failed bulk read through that path. Matrix, Microsoft Teams, and Voice Call retain this compatibility until their declared minimum host supplies the capability. Do not import a new helper export from an older host just to detect this method.

    `count()` returns the number of live stored rows in the runtime-bound plugin and namespace without loading or decoding their JSON values. A row expires when its expiry timestamp is at or before the call's cutoff. Counting does not delete expired rows, create a missing database, or join the writable database lifecycle. Corrupt JSON still occupies a live row and is counted; `lookup` and `entries` retain their decoding errors. Database acquisition and query failures propagate with operation `count`. A count and a later write are separate operations; the write remains responsible for enforcing capacity.

    Current host factories provide `count`, but it remains optional in the public async and synchronous store types for shipped hosts and adapters through the next Plugin SDK major. Callers supporting those stores can use `store.count ? await store.count() : (await store.entries()).length`; synchronous callers omit `await`. The fallback retains the older store's enumeration and decoding behavior. Only fall back when the method is absent, never after a failed count.

    `openSyncKeyedStore<T>(...)` remains available for callers that cannot await, with its existing synchronous return values and errors. It is deprecated through the `next-plugin-sdk-major` compatibility gate. See [Synchronous keyed store migration](/plugins/sdk-runtime/state-and-system#synchronous-keyed-store-migration).

    `openBlobStore<TMetadata>(...)` stores bounded binary payloads in shared SQLite without base64 or file sidecars. It requires per-entry, per-namespace byte, and row limits; copies byte arrays at the API boundary; and lists metadata without loading every BLOB. `register(...)` is an explicit upsert, including for expired keys. `registerIfAbsent(...)` provides collision-safe creation: an expired key remains occupied until its owner claims it with `deleteExpiredKey(key)` or `deleteExpired()`, preserving metadata needed to remove related named artifacts after the SQLite commit. Any row with a TTL is transient and excluded from backup/restore even before it expires; omit TTL for durable, restorable state. Host fuses cap each BLOB at 100 MiB, each plugin at 512 MiB of physically stored BLOBs, and each plugin at 50,000 physically stored rows, including expired rows awaiting owner cleanup. Use `registerIfAbsent(...)` with `overflowPolicy: "reject-new"` when external materializations must not be silently orphaned by replacement or eviction.

    Blob mutations use the shared SQLite worker and keep quota checks and changes in one transaction. `lookup` and `entries` use the retained read-only worker path. Missing stores stay absent. Ordinary unselected reads observe independently committed data; an unrelated cached native cursor can retain an older view. An explicitly selected snapshot keeps its private source through completion. Await all methods before publishing dependent artifacts or removing their storage. Shared reader admission is bounded: process inventories sequentially or with bounded concurrency, and join every started operation before reporting a batch failure or completing shutdown. Worker errors preserve `PluginBlobStoreError` classification, operation, path, and causal errors. Byte copying, metadata serialization, and complete result materialization still use caller memory; this is not a streaming BLOB API.

    `openChannelIngressQueue<TPayload>(...)` opens a persisted ingress queue scoped to the calling plugin, for buffering inbound events that need at-least-once processing across restarts. When stale-claim recovery uses `shouldRecover`, also provide `shouldRecoverCorrupt` if corrupt claimed payloads should be quarantined: its payload-independent claim identity lets the plugin preserve live owner and lane policy before the queue tombstones the row.

    Plugin-state leases were removed in 2026.8.1. Use short SQLite transactions for atomic database work and plugin-scoped keyed stores (`openKeyedStore` or `openSyncKeyedStore`) for bounded durable state.

    `openChannelIngressDrain(...)` opens the core channel-agnostic worker over that queue (or creates a queue when none is supplied). The drain owns stale-claim recovery, per-lane claim serialization, complete-at-adoption or complete-on-dispatch-return, retry/dead-letter disposition, optional pre-adoption supersede, and claim→adoption stall timeout. Wire claim ownership into reply generation with `turnAdoptionLifecycle` (via `bindIngressLifecycleToReplyOptions` from `plugin-sdk/channel-outbound`). Channel plugins keep accept-side enqueue, lane derivation, non-retryable classification, and any supersede authorization policy.

    <Warning>
    `openBlobStore`, `openKeyedStore`, `openSyncKeyedStore`, `openChannelIngressQueue`, and `openChannelIngressDrain` are available only to bundled plugins and trusted official plugin installations in this release. Refusals include the recorded reason, registry database path, origin, and install source/spec; `plugins inspect` reports the same trust facts. A load path selecting the recorded official installation preserves trust; an untracked local copy does not. See [Trusted plugin state refused](/tools/plugin#trusted-plugin-state-refused) for doctor migrations and cause-specific remedies. An untrusted channel's ingress monitor fails channel start instead of running without a durable queue.
    </Warning>

  </Accordion>
</AccordionGroup>

## Synchronous keyed store migration

`api.runtime.state.openSyncKeyedStore` and `PluginStateSyncKeyedStore` are deprecated
as of September 11, 2026. The existing `createPluginStateSyncKeyedStore` factory is
the named `plugin-state-sync-keyed-store` compatibility adapter. Existing methods
remain supported through the next Plugin SDK major; removal also requires a
supported external-plugin migration and explicit breaking-release approval.

Use `api.runtime.state.openKeyedStore` with the same namespace and options, then
await its operations. The opener itself still returns a store synchronously.
Both interfaces use the same plugin-scoped data, so no data migration is needed.

Deferred runtime code without a bound plugin API can import
`createPluginStateKeyedStore` from `openclaw/plugin-sdk/plugin-state-store-runtime`.
Pass the plugin ID and the same namespace options, then await each operation.
Keep this import lazy because the factory loads the state database runtime.

```typescript
const store = api.runtime.state.openKeyedStore<MyRecord>({
  namespace: "my-feature",
  maxEntries: 200,
});
await store.register("key-1", { value: "hello" });
const value = await store.lookup("key-1");
```

For writes on behalf of a current tool invocation or other revocable action,
require `store.withCurrent` before starting effects. Bind the host-provided
assertion together with any action-specific permission check:

```typescript
if (!store.withCurrent) {
  throw new Error("Update OpenClaw to authorize this state mutation.");
}
const actionStore = store.withCurrent({
  assertCurrent: () => {
    context.assertInvocationCurrent();
    assertActionAllowed();
  },
});
await actionStore.register("key-1", { value: "hello" });
```

The returned `PluginStateKeyedStore<T, 2>` is an immutable binding to the same
namespace, settings, and plugin lifetime. It exposes the data-only operations;
it has no `update`, `deleteIf`, or rebinding method. The assertion stays on the
host and is checked after reads and at both transaction and final commit
admission for writes, including bounded stores. Create a separate view for each
action; do not keep one caller's authority on a shared service. The legacy
`PluginStateKeyedStore<T>` keeps this capability optional for older hosts and
adapters. An action requiring it must refuse when it is absent.

`observe` and a comparison conflict return observations without committing the
requested mutation; they also require current authority when returning that data.

A refusal before the commit grant rolls back the mutation. Once commit is
authorized, later revocation does not turn the settled write into a refusal.
Recheck authority before the next external effect, and preserve the recorded
result; never retry a committed or unknown write to compensate for revocation.

The async store's `update` updater and `deleteIf` predicate are deprecated
compatibility methods. They still run synchronously on the main thread inside
the transaction containing the authoritative read and mutation, and remain
supported through the next Plugin SDK major.
Finish asynchronous planning before calling these methods; do not make their
callbacks async or replace atomic operations with separate lookups and writes.
Returning `undefined` from an updater leaves the entry unchanged. `update`,
`deleteIf`, `lookupMany`, and `count` remain optional in public store types, so preserve
capability checks for supported older hosts and third-party adapters.

For new atomic mutations, use the optional `observe` and `compareAndApply`
methods. `observe(key)` prepares a mutation through canonical writable database
admission and may create or open state. It returns `{ value, comparison }`; use
`lookup` for a plain, noncreating read. No transaction remains open while the
caller prepares the next value.

`compareAndApply(key, comparison, intent)` compares the current live row before
changing it in the same worker-owned transaction. The opaque comparison binds
the actual database, plugin, namespace, key, stored JSON bytes, creation time,
and expiry. It compares content and metadata; it is not an incarnation token or
permission to act. Another store or key rejects the comparison with
`PLUGIN_STATE_INVALID_INPUT`.

The intent is explicit:

- `{ operation: "update", action: "set", value, ttlMs? }` writes a defined value
  and refreshes its creation time and TTL, even when the value is unchanged.
- `{ operation: "update", action: "keep" }` leaves the entry unchanged while
  retaining writable admission and the existing namespace expiry sweep.
- `{ operation: "delete", action: "delete" }` removes a matching live entry.
- `{ operation: "delete", action: "keep" }` retains writable admission without
  an expiry sweep or entry mutation.

The result is `{ status: "applied" }`, `{ status: "unchanged" }`, or
`{ status: "conflict", current }`. A conflict does not change plugin-state rows
and supplies a fresh observation. An entry that expires after observation
conflicts; missing and expired entries otherwise share logical-absence semantics.
Existing quotas, eviction order, validation, and store errors still apply.

On an explicit conflict, a plugin may recompute a named pure decision from
`current.value` and try again. Prepare clocks, randomness, and external effects
outside that decision. Never retry transport failures, unknown outcomes, or
arbitrary callbacks. Check both optional methods before using this capability;
there is no safe fallback consisting of a separate lookup and unconditional write.

`registerIfAbsent` and the optional `deleteIfEqual(key, expected)` operation use
the shared-state SQLite worker. `deleteIfEqual` accepts a string, finite number,
boolean, or `null`, and compares it with the decoded live value in the same
transaction as deletion. Missing or expired entries return `false`; malformed
stored JSON remains a typed store error. These operations share existing data,
limits, and expiry rules with the legacy synchronous store.

`register`, `lookup`, `lookupMany`, `consume`, `delete`, `entries`, `count`, and `clear`
also execute SQLite in the same worker. Reads preserve missing-store behavior
without creating a database. `lookupMany` returns one result per input key,
including duplicates and per-key corrupt-value errors. `consume` reads and
deletes atomically; a decode failure rolls back the deletion. Store creation,
input validation, and JSON serialization remain on the calling thread.

Callback-based `update` and `deleteIf` retain the native synchronous transaction;
do not replace either with a separate lookup and write. Worker errors retain `PluginStateStoreError` codes, operation, and path. Canonical
state errors use their existing codec; other native causes retain bounded causal
messages and error codes. Arbitrary custom properties and original stacks do not
cross the worker boundary.

Discord and Slack use scalar conditional deletion when relinquishing a presence
cooldown. On older hosts without that optional capability, they leave it to expire
instead of risking deletion of a newer reservation.

FaceTime persists pending dial snapshots in invocation order and uses worker
comparisons to clear only the matching dial. Helper dispatch waits for durable
intent, and shutdown joins accepted persistence. Its supported 2026.9.4 hosts
without comparisons retain atomic `deleteIf` cleanup; a failed worker operation
never selects that compatibility path. The namespace, stored records, and
retention remain unchanged, so this cutover requires no data migration.

This deprecation adds editor annotations, documentation, and compatibility
inventory metadata. It adds no runtime warning and changes no trust eligibility:
the runtime openers remain limited to bundled plugins and trusted official
installations. Runtime warnings should wait for an actionable supported upgrade.
Only the operations identified above execute on the worker. Callback execution
is unchanged during this migration.

## Per-agent SQLite writes

Bundled and official plugins that already use the private `sqlite-runtime`
facade can import `withOpenClawAgentDatabaseWrite` from
`openclaw/plugin-sdk/sqlite-runtime`. This remains an internal runtime facade,
not a typed public SDK entrypoint for third-party plugins.

Call it from an asynchronous producer before entering synchronous SQLite. It
shares the agent database's in-process write admission with session writers and
off-thread reclamation, leaving the Gateway thread available to authorize a
reclamation commit.

Asynchronous AgentSession message, model, compaction, and tree operations use
this admission for their transcript writes. Embedded prompt preparation, replay
repair, and tool-result cleanup await their writes before publishing dependent
results or disposing their resources. Model-selection hooks run after write
admission releases. SessionManager `appendModelChange` and
`appendThinkingLevelChange` return promises for their committed entry IDs;
AgentSession and extension `setThinkingLevel` return `Promise<void>`. Await these
operations before using the resulting model or thinking state. Other synchronous
SessionManager operations still need an appropriate caller-owned write boundary.

`SessionManager.appendMessageToTranscript` is a deprecated public SDK compatibility
method, retained for plugins using the v2026.9.5 contract. It accepts ordinary,
custom, and Bash execution messages and synchronously returns the persisted
message ID. It delegates to the canonical append kernel and can perform SQLite
work on the calling thread. Removal requires a versioned SDK replacement and a
plugin migration window; the bundled failed-image path does not call it.

Core failed-image settlement uses the internal `appendSessionTranscriptNote`
operation, which accepts a custom message and returns a promise for its persisted `messageId`, canonical
`message`, the append owner's `appended` result, and a `currentTail` fact from the same snapshot.
The tail fact uses the transaction's visible leaf and generation: side metadata does not suppress a retry's publication, while a later visible entry does.
File-backed notes use the same canonical agent worker and writer queue, reserving their turn
before asynchronous target preparation. The embedded runner awaits its failed-image note before publishing that stored message in live context or the
completed result when the owner appended it or confirms it is still the current tail after a lost reply. An idempotent historical result does not reintroduce a note omitted by compaction. Input and target capture precede awaited work; transaction and
publication checks retain the original writer and session binding. A known
commit followed by a publication failure retains its message ID and prevents
model fallback from replaying the append. Incognito notes use the same canonical
append snapshot under their existing process-held native write owner until its
actor cutover; this path still performs caller-thread SQLite work. It leaves the
manager's loaded view unchanged and applies the same fresh-append/current-tail
publication rules. Detached notes continue through their in-memory manager owner.
Canonical storage close revokes pending asynchronous notes and joins their target
preparation, accepted work, and cleanup before releasing the store.
Failed-image notes use the existing message idempotency key to survive redaction
and same-run retries. Existing unkeyed notes retain their run-metadata matching.

`SessionManager.open`, `openBounded`, and `setSessionTarget` capture `storePath`
as an absolute lexical locator before reading the transcript or invoking
`onTruncated`. Relative locators resolve against the process working directory
at entry; `getSessionTarget()` returns that captured locator. Later working
directory changes leave the manager bound to its original store. The binding also
captures the resolved state directory and supervisor mode; environment changes
cannot redirect later writes. Existing `sessions.json` and custom-store routing
and symlink spelling are preserved.

File-backed model and thinking transcript writes execute through the canonical
agent database worker. Queued extension actions retain their original runtime
and session authority through transaction and commit admission. Synchronous session
opening, final model-context validation, and incognito transcript persistence still use
their native owners; an asynchronous method does not imply that every storage
operation in the enclosing session flow runs off-thread.

Committed metadata updates the bound session's model or thinking state alongside
transcript-view adoption, before asynchronous cleanup. Settings setters retain
their existing persistence queue. If view reconstruction, local publication, or
a dependent thinking change fails after the append commits, the error preserves
the committed entry and prevents model fallback from replaying it. A failed view
reconstruction makes the existing manager refuse further transcript access;
discard it and reopen through the session owner after resolving the read failure.
Retrying the append would duplicate a write that already committed.

The signature is `withOpenClawAgentDatabaseWrite(options, operation, expectedDatabase?)`.
`options` uses the existing agent database options, including the required
`agentId` and optional concrete `path`. The synchronous `operation` receives the
`OpenClawAgentDatabase`; the returned promise resolves to its result after the
operation settles. Without `expectedDatabase`, the helper also owns asynchronous
database-open admission. The helper captures the environment, selected state
directory, and database path before waiting, so changing the working directory does not retarget
a queued write. Opening or borrowing a handle alone does not admit a write.

For an already borrowed handle, pass its exact `DatabaseSync` as the third
argument. After waiting, the helper rejects a closed or replaced handle rather
than opening a replacement on its behalf. Keep the original borrow alive until
the operation settles. The caller still owns transactions and authorization.
For large native publications, `openOpenClawAgentSqliteWorkerStore(options, borrowedDb, { moduleUrl, input })`
retains the original borrowed handle and physical identity. Its
`run(operation, assertCurrent)` joins the existing agent writer queue and borrows
the canonical agent executor for the complete operation. The module exports
`bindSqliteWorkerBackend(input, { databasePath, database, admit })`; it uses the
supplied connection and closes only its own temporary state. It must not open or
close the agent database. The operation receives only the bound backend's
`execute` method; finish it before calling `close()`. Client close revokes new work,
drains its accepted operations, and releases its original borrow. The canonical
executor owns the native connection, lease, idle reuse, and final close.

A backend used with this owner requests `transaction` admission after BEGIN and
`commit` admission immediately before COMMIT through the supplied `admit` callback.
The host checks the canonical connection and current caller authority at
both points without waiting synchronously for the native transaction. An accepted
commit grant orders the commit before later revocation; an earlier refusal rolls
back. Callers must preserve committed or unknown outcomes and never replay them.
Private file owners can use `runSqliteWorkerStoreWrite` with their own admission
and lifetime; it does not supply the shared agent queue or lease.

`runSqliteWorkerStoreOperation(store, operation, undefined, assertCurrent)` retains
one existing worker actor and checks the supplied authority through broker
admission. Use it when a private store has prepared a command asynchronously;
checking only before worker opening leaves pending work authorized by an old
snapshot. This operation helper preserves accepted native settlement and does
not add a transaction/commit handshake to backends that do not implement one.

Worker backends can load module prerequisites asynchronously in `prepare(command)`.
Preparation carries captured state/runtime facts and performs no native work.
After it settles, `execute(command)` enters fresh synchronous authority scopes;
connection-bound execution revalidates authority before native work. Extension
loading, transactions, and domain callbacks remain synchronous. Agent connection policy, including TEMP
storage, belongs to the canonical connection owner and cannot be reset when a
publication binds.

Backends whose failure handling can leave an unusable native connection implement
synchronous `assertSettled()`. The broker calls it after a command returns or
throws. A failed assertion retires the Worker and waits for native exit before
releasing operation admission. Use `assertTransactionUsable(db)` to detect the
transaction owner's retained failure, and reject any surviving open transaction.
Ordinary failures that rolled back safely can still return their domain result.

For example, given an existing `borrowedDb`, a live-owner `assertCurrent()` check,
and synchronous `applyPreparedChanges(db)`:

```typescript
import {
  runSqliteImmediateTransactionSync,
  withOpenClawAgentDatabaseWrite,
} from "openclaw/plugin-sdk/sqlite-runtime";

await withOpenClawAgentDatabaseWrite(
  { agentId, path: databasePath },
  ({ db }) =>
    runSqliteImmediateTransactionSync(db, () => {
      assertCurrent();
      applyPreparedChanges(db);
    }),
  borrowedDb,
);
```

Prepare files, embeddings, network results, and hook decisions before requesting
write admission. Keep the admitted callback synchronous; do not return a promise
or hold admission across a provider call or an entire asynchronous hook. Recheck
applicable manager/run ownership and cancellation inside the callback, immediately
before mutation. Agent identity and handle equality are not authorization.

For preparation that can repeat after SQLite lock contention,
`runSqliteImmediateTransaction(db, prepare, options, admit)` accepts the same
owner's admission callback. `prepare` runs before admission and returns a
synchronous transaction callback. Pass `(write) =>
withOpenClawAgentDatabaseWrite(databaseOptions, write, borrowedDb)` as `admit`;
do not place asynchronous preparation inside the admitted callback. The helper
rechecks transaction state after waiting and never repeats a callback that
already entered its transaction.

`withOpenClawAgentDatabaseWrite` does not start a transaction, grant an authority
lease, or coordinate unrelated processes. Raw SQLite calls outside admission bypass it, and existing
synchronous APIs do not become asynchronous automatically. A rejected stale-owner
write must return to its lifecycle owner for recovery, not retry with a replacement
handle. For storage design and migration requirements, see
[Database schemas](/reference/database-schemas).
