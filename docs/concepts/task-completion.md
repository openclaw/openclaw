---
summary: "Route leases let detached-task completion delivery recover the originating outbound target across session eviction, bucket retargeting, and process restarts."
read_when:
  - Touching the task-route lease module or its schema
  - Debugging detached-task completion delivery that loses the originating channel
  - Reasoning about cross-crash delivery origin recovery
title: "Task completion and route leases"
---

A detached task (`cron`, `subagent`, `ACP`, `codex`) is created in one process, runs over time, and emits a completion envelope in another. The completion announcer must resolve the outbound origin (`channel`, `to`, `thread`) at delivery time, but by then the originating session entry may be evicted, the shared main session bucket may be retargeted by another conversation, or the explicit `delivery` config may not survive all the way to the announce step.

The route lease is the per-run recovery record. It captures the originating outbound origin once at task start, keeps it in SQLite under the shared state database, and exposes it to the completion-time resolver as a session-identity fallback.

## Why a separate lease

The completion-time resolver already has higher-precedence sources:

1. The live session entry (most precise, but can be evicted)
2. The active main session bucket (most useful, but can be retargeted)
3. The task's stored `delivery` config (can be partial or stale)

When all three lose the outbound target, the resolver falls back to the route lease. The lease is keyed by the `(run_id, runtime, scope_kind, owner_key, child_session_key)` tuple — the same scope facts the task registry uses to disambiguate shared-runId task records. The lease is keyed by that 5-tuple rather than `task_id` because a single task may produce multiple runs over time, and each run owns its own delivery origin within its scope.

## Lifecycle

| Phase   | What happens                                                                               | Where it is triggered                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Acquire | Insert a row with `status='active'`, fresh TTL, captured `requester_origin_json`           | `createRunningTaskRun` auto-acquires unless `deliveryStatus === "not_applicable"`                                      |
| Update  | Replace the captured origin after the resolver produces a concrete `(channel, to, thread)` | `updateTaskRouteLease` from the delivery-target resolver post-resolve hook                                             |
| Extend  | Bump `expires_at` for long-running tasks                                                   | `extendTaskRouteLease` from periodic liveness checks                                                                   |
| Settle  | Transition to `status='settled'` or `'retired'` on terminal delivery status                | `setDetachedTaskDeliveryStatusByRunId` auto-settles when delivery status is `delivered`, `failed`, or `session_queued` |
| GC      | `expireStaleTaskRouteLeases` marks stale rows as `'expired'`                               | Periodic timer, gateway startup                                                                                        |
| Cleanup | `deleteTaskRouteLeasesByTaskIdInDb` removes rows when the owning task is deleted           | `task-registry.store.sqlite.ts:deleteTaskRowsWithDeliveryState` cascade                                                |

## Storage invariant

The `task_route_leases` table has **no foreign key** on `task_id`. Leases are sometimes acquired before the parent `task_runs` row exists (cron pre-flight) and the lease module owns its own lifecycle independent of `task_runs`. The `task_id` column is kept for indexed lookup and forensic correlation, not referential integrity.

The `idx_task_route_leases_task_id` index supports the cascade cleanup in `deleteTaskRowsWithDeliveryState`. Without the cascade, settled, expired, and orphaned leases would accumulate in the shared state database after ordinary task cleanup.

## Ownership

The route lease module is the SQL owner of `task_route_leases`. Other subsystems (task executor, task registry store, cron delivery resolver) call into the module's public API rather than reaching into the table directly. Cleanup helpers that need to be transaction-scoped accept an open `DatabaseSync` handle so the caller can manage the surrounding transaction; transaction-free helpers open their own write transaction.

## Related

- [Message lifecycle refactor](/concepts/message-lifecycle-refactor)
- [Queue modes](/concepts/queue)
- [Retry and backoff](/concepts/retry)
