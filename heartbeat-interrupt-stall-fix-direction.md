# Heartbeat interrupt stall, proposed fix direction

## Problem

A main-session user task can lose or delay its final user-visible reply when heartbeat/system-event turns interrupt the session flow.

## Goal

Preserve final user delivery for the original task even when heartbeat or exec-completion events arrive mid-flight.

## Recommendation

Use a two-phase fix.

## Phase 1, low-risk mitigation

### Add stronger heartbeat deferral while user-directed work is active

If the main session has active user-directed work or a recent unfinished tool-backed turn, non-urgent heartbeat turns should be deferred more aggressively.

### Why

This is the lowest-risk way to reduce visible stalls quickly.

### Tradeoff

It reduces interruption pressure but does not fully solve resume semantics.

## Phase 2, durable correctness fix

### Add generic pending final delivery for main-session turns

Generalize the subagent `pendingFinalDelivery` idea beyond `SubagentRunRecord`.

Suggested shape:

- persist a pending final delivery marker for unfinished main-session user turns
- bind it to the correct parent turn/run identity
- on interrupt or restart, retry final user delivery until resolved
- clear state only after successful user-visible completion

### Why

This directly targets the real reliability problem: losing the original final reply.

### Important constraint

Do not reuse stale payload across unrelated turns. The subagent PR lesson still applies: delivery state must be bound to the correct turn identity.

## Non-recommended as sole fix

### Only improving exec-event relay

Useful, but not enough by itself.
It may improve async event reporting while still leaving the original user task without a durable resume path.

## Suggested implementation order

1. add a failing regression test for main-session interrupt + missing final reply
2. implement stronger heartbeat deferral for active user work
3. add durable pending-final-delivery or resume state for main-session turns
4. verify that interrupting heartbeat/system events no longer strand the original task

## Why this order

It gives:

- a quick mitigation first
- a correctness fix second
- a clear path to validate behavior without overcommitting to a large redesign

## Short conclusion

If choosing only one deep fix, pick:
**generic pending final delivery or resume support for main-session turns**

If choosing the fastest immediate mitigation, pick:
**stronger heartbeat deferral while user-directed work is active**
