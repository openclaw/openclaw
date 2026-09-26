---
summary: "Durable, child-bound callbacks for asynchronous plugin tools"
title: "Async tool callbacks"
read_when:
  - "Returning delayed plugin tool results to a waiting native child"
---

# Durable plugin tool callbacks: contract and behavior matrix

V2 plugin tools can issue a durable callback bound to their current native child.
The plugin receives an opaque token, not permission to select a session. After
an external job finishes, the same plugin can redeem the token from its active
runtime, including after a restart. OpenClaw queues the result for the original
child and preserves its existing task and requester completion route.

This API requires a non-collector native child. It does not automatically yield
the agent: return a pending response instructing the child to call
`sessions_yield({ waitFor: "message" })`. A child that finishes normally, is
cancelled, or is replaced cannot be resumed with the old callback.

Owner: the host, not the plugin. A plugin tool may return `pending` only after the host has durably bound a fresh opaque callback capability to the exact tool invocation and native child session. A callback result is data for that same child, not a request to select a new session or delivery target. The child completes through its normal completion and requester-delivery owners. The capability alone conveys no right to send to an arbitrary requester.

| State / event                                       | Required outcome                                                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Admitted child tool returns pending                 | Persist capability, invocation and child lifecycle identity before reporting pending; no successful final answer yet. |
| Valid completion before deadline                    | Consume capability once; enqueue result to exact child, whose normal completion routes to the original requester.     |
| Two concurrent children, including same plugin/tool | Distinct capabilities and exact child/turn bindings; never cross-deliver.                                             |
| Same completion again                               | Report already consumed; never enqueue a second turn.                                                                 |
| Unknown, forged or mismatched capability            | Reject without revealing child/requester identity or changing state.                                                  |
| Deadline elapsed                                    | Reject completion; terminalize pending work with a visible expiry outcome.                                            |
| Child cancelled/reset/replaced                      | Recheck authoritative child/session lifecycle before claiming; reject stale capability.                               |
| Gateway restarts at any cut point                   | Restore pending claims and any committed completion outbox; no loss or duplicate delivery.                            |
| Delivery transport fails after claim                | Keep a durable outbox and retry/reconcile with the original idempotency identity.                                     |
| Non-child or unbound caller                         | Reject pending mode rather than guessing a parent or delivery target.                                                 |

A V2 plugin can call `await ctx.issueAsyncCallback({ ttlMs: 60_000 })` during its registered tool's `execute`, persist `handle.token` in plugin-private storage, and later call `await handle.complete(text)` or, after a restart, `await api.asyncToolCallbacks.complete({ token, resultText: text })`. Never return the token in tool content, logs or model-visible output. The plugin must return a pending tool response that tells its child to call `sessions_yield({ waitFor: "message" })`; a normal final answer will settle the child before its callback. The plugin does not choose a callback destination. TTL is at most seven days; the durable receipt expires no later than seven days beyond the deadline. If the child remains running or queued rather than yielding, the queue waits at most one hour after the later of enqueue and delivery availability, then moves the result or expiry to its failed queue instead of deferring forever.

No plugin-supplied session key, recipient, channel, run ID, or completion token is trusted as authority. Callback admission and completion need current host authority, including plugin lifecycle revocation. The completion API must not require a model turn, an installed transport-specific integration, or a live initiating tool promise. Timeout, retention, downgrade, and disclosure policy need explicit bounds. This contract is not met by a transient in-memory Promise or by simply sending a new message to the requester.

Callback rows use a separate delivery queue namespace, handled by the same session-delivery owner. Older runtimes leave these rows untouched rather than misinterpreting them as restart wakes. Resume with a callback-capable runtime to process them after rollback.
