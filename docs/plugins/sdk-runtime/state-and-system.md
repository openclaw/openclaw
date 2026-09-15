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

    Keyed stores survive restarts and are isolated by the runtime-bound plugin id. Use `registerIfAbsent(...)` for atomic dedupe claims: it returns `true` when the key was missing or expired and registered, or `false` when a live value already exists without overwriting its value, creation time, or TTL. Use `observe(...)` with `compareAndApply(...)` when a mutation depends on the current value; the comparison and mutation run in one SQLite worker transaction. Limits: `maxEntries` per namespace, 50,000 live rows per plugin, JSON values up to 1 MiB of UTF-8 encoded JSON, and optional TTL expiry. By default, a write at either row limit sheds the oldest live rows from the namespace being written; sibling namespaces are not evicted for that write, and the write still fails if the namespace cannot free enough rows. Set `overflowPolicy: "reject-new"` for durable ownership records that must never be evicted: new keys fail at either limit, while existing keys remain updateable.

    `lookupMany(keys)` is an optional keyed-store capability for at most 10,000 exact keys per call. Results have the same length and order as the input, including duplicates. Each position is a `Result<T | undefined, PluginStateStoreError>`: `{ ok: true, value }` on success, including `value: undefined` for missing or expired keys, or `{ ok: false, error }` for corrupt stored JSON. An empty request returns `[]`. Keys use the same trimming and 512-byte UTF-8 limit as `lookup`; invalid keys or an oversized request fail with `PLUGIN_STATE_INVALID_INPUT` and operation `lookup` before reading. Database acquisition and query errors fail the whole call. Corrupt-JSON errors retain the `lookup` error code and operation in their per-key result. Inspect each result only when the reader reaches that position, and throw `result.error` if it is not `ok`; this lets a reader stop at an earlier missing or invalid chunk without raising a later corruption error. Each call uses one expiry cutoff and one SQLite selection in the same plugin and namespace, without creating a missing database. Separate calls, including metadata reads, do not share a snapshot; chunked formats must retain their generation, digest, and reader-lifetime checks.

    Current host factories provide `lookupMany`, but the public store types keep it optional for existing third-party adapters and declared older host versions. A plugin supporting those hosts must check the method and use its existing sequential `lookup` path when absent; never retry a failed bulk read through that path. Matrix, Microsoft Teams, and Voice Call retain this compatibility until their declared minimum host supplies the capability. Do not import a new helper export from an older host just to detect this method.

    `count()` returns the number of live stored rows in the runtime-bound plugin and namespace without loading or decoding their JSON values. A row expires when its expiry timestamp is at or before the call's cutoff. Counting does not delete expired rows, create a missing database, or join the writable database lifecycle. Corrupt JSON still occupies a live row and is counted; `lookup` and `entries` retain their decoding errors. Database acquisition and query failures propagate with operation `count`. A count and a later write are separate operations; the write remains responsible for enforcing capacity.

    Current host factories provide `count`, but it remains optional in the public async and synchronous store types for shipped hosts and adapters through the next Plugin SDK major. Callers supporting those stores can use `store.count ? await store.count() : (await store.entries()).length`; synchronous callers omit `await`. The fallback retains the older store's enumeration and decoding behavior. Only fall back when the method is absent, never after a failed count.

    `openSyncKeyedStore<T>(...)` remains available for callers that cannot await, with its existing synchronous return values and errors. It is deprecated through the `next-plugin-sdk-major` compatibility gate. See [Synchronous keyed store migration](/plugins/sdk-runtime/state-and-system#synchronous-keyed-store-migration).

    `openBlobStore<TMetadata>(...)` stores bounded binary payloads in shared SQLite without base64 or file sidecars. It requires per-entry, per-namespace byte, and row limits; copies byte arrays at the API boundary; and lists metadata without loading every BLOB. `register(...)` is an explicit upsert, including for expired keys. `registerIfAbsent(...)` provides collision-safe creation: an expired key remains occupied until its owner claims it with `deleteExpiredKey(key)` or `deleteExpired()`, preserving metadata needed to remove related named artifacts after the SQLite commit. Any row with a TTL is transient and excluded from backup/restore even before it expires; omit TTL for durable, restorable state. Host fuses cap each BLOB at 100 MiB, each plugin at 512 MiB of physically stored BLOBs, and each plugin at 50,000 physically stored rows, including expired rows awaiting owner cleanup. Use `registerIfAbsent(...)` with `overflowPolicy: "reject-new"` when external materializations must not be silently orphaned by replacement or eviction.

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

```typescript
const store = api.runtime.state.openKeyedStore<MyRecord>({
  namespace: "my-feature",
  maxEntries: 200,
});
await store.register("key-1", { value: "hello" });
const value = await store.lookup("key-1");
```

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

Slack uses scalar conditional deletion when relinquishing a presence cooldown.
On older hosts without that optional capability, it leaves the cooldown to expire
instead of risking deletion of a newer reservation.

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
admission releases. Synchronous SessionManager and extension APIs, including
`setThinkingLevel`, retain their existing synchronous contracts and still need
an appropriate caller-owned write boundary.

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
