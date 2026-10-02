---
summary: "Child-bound asynchronous plugin callbacks, with RAM-only incognito lifetime"
title: "Async tool callbacks"
read_when:
  - "Returning delayed plugin tool results to a waiting native child"
---

# Async plugin tool callbacks

V2 plugin tools can issue a callback bound to their current native child. The
plugin receives an opaque bearer token, not permission to choose a session or
recipient. Redeeming it queues untrusted result data for that same child. The
child completes through its normal task and original-requester delivery owners.

This API requires an admitted, non-collector native child. It does not
implicitly yield: return a pending tool response instructing the child to call
`sessions_yield({ waitFor: "message" })`. A child that finishes normally, is
cancelled, or is reset/replaced cannot be resumed by its old callback.

## Issue, complete, and inspect

During the registered tool's `execute`, call
`await ctx.issueAsyncCallback({ ttlMs: 60_000 })`. The returned handle exposes
`token`, `expiresAt`, `storage`, `complete(resultText)`, and `status()`.
Issuance must settle before reporting pending; detached work cannot issue after
its originating invocation returns or fails.

An active instance of the same plugin can also call
`api.asyncToolCallbacks.complete({ token, resultText })` or
`api.asyncToolCallbacks.status({ token })`. This supports ordinary-session
completion after a Gateway restart without keeping the original tool promise.
Plugin retirement revokes the old instance; it does not authorize a replacement
plugin identity to redeem another plugin's token.

- **Maximum redemption lifetime: 24 hours.** Overlong or invalid TTLs are
  rejected, not silently extended. Incognito additionally caps this at the
  session's existing deadline.
- **One outstanding callback per native child/run**, across plugins and tools.
  Acceptance does not free this slot; terminal delivery settlement does.
- **Capacity:** at most 100 outstanding callbacks per plugin and 1,000 per
  storage owner (durable database or live RAM runtime). Overflow is rejected
  without evicting admitted work. Result text is limited to 32,000 characters.
- **Accepted is not delivered.** A successful redemption returns `accepted`;
  repeating it returns `duplicate`. Inspect the receipt for `pending`,
  `accepted`, `delivered`, `failed`, `expired`, or `cancelled`.
  `delivered` means the native continuation was admitted, not that the child's
  task or its final requester delivery succeeded. `unknown` covers invalid,
  inaccessible, revoked, or forgotten receipts without revealing their route.
- **Delivery is bounded.** The existing queue retries transient failures. A
  child that never yields cannot retain a result forever: there is a one-hour
  yield grace after result acceptance or the callback's expiry deadline. A
  terminal delivery failure is inspectable as `failed`; plugins must not treat
  `accepted` as proof of task completion.

## Incognito is RAM-only

For an incognito child, `storage === "memory"`. The capability ledger, queued
payload, retries, and receipts live only in the Gateway process. Restarting or
stopping its runtime destroys them, including accepted-but-undelivered results.
Session deletion, reset, archive, replacement, or expiry revokes the original
memory owner; an old token cannot attach itself to a newly created session.
The original physical RAM database and lifecycle identity must remain current.
No private callback falls back to the persistent queue.

**Plugin authors must honor this mode too:** do not persist memory-mode tokens
or results in plugin state, files, logs, or third-party job metadata merely to
recover them after restart. OpenClaw cannot erase a copy a plugin or external
service has independently retained. A lost incognito callback must be started
again as new work, not replayed against a replacement session. Memory receipts
are bounded and may be forgotten after settlement; none outlive the session.

For `storage === "persistent"`, store tokens only in plugin-private storage if
restart recovery is needed. Never include tokens in model-visible tool output,
transcripts, shared logs, or public URLs. Possessing a token does not replace
current plugin and exact native-child authority checks.

## Recovery and rollback

Ordinary callbacks use one host-owned capability ledger and atomic result
outbox. Completion and expiry serialize; duplicate redemption cannot enqueue
another result. Pending work survives restart, while reset/cancellation checks
remain mandatory at delivery. Receipt retention is separate from redemption:
ordinary capability receipts become eligible for cleanup **one day after the
callback deadline**. Compact queue receipts use a **one-day retention window
after terminal settlement**. Existing bounded maintenance performs the cleanup;
there is no per-receipt polling loop or exact-time physical-deletion guarantee.
These are separate from the **24-hour maximum redemption lifetime**: retention
is not permission to submit a late result. Receipt cleanup does not discard an
accepted result that the delivery owner has not yet settled.

Callback deliveries use a separate queue namespace under the existing
session-delivery owner. Compatible older runtimes leave these rows untouched
rather than misinterpreting them as restart wakes. Namespace isolation does not
make incompatible database schemas readable: for example, published 2026.9.6
supports state schema 18 and cannot open a candidate already at schema 19.
Follow the [database downgrade recovery guidance](/reference/database-schemas/integrity-and-recovery#downgrade-recovery);
never lower schema markers to force a rollback.

A manual restore of historical state is a rewind, not a global exactly-once
boundary for external side effects. Plugins whose jobs modify external systems
must use their own stable job/idempotency identity and reconcile the external
result before repeating those effects. Automatic updater rollback retains its
existing refusal to discard newer committed database writes.
