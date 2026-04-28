# pendingFinalDelivery Upstream Audit (2026-04-11)

## Question

Before continuing the local `pendingFinalDelivery` work, check whether recent upstream OpenClaw commits already solved the same problem.

## Short Answer

**Not exactly.**

Recent upstream work clearly improved the surrounding follow-up and reply lifecycle machinery, but the exact local idea of a durable `pendingFinalDelivery` record on the subagent run is still a **local uncommitted patch**, not a committed upstream feature.

## What upstream already improved

### Relevant recent commits

- `93e509ccfe` `fix(reply): use runtime snapshot for queued reply runs`
- `43e6c923de` `perf(auto-reply): extract followup delivery seam`
- `3f6840230b` `fix: unify reply lifecycle across stop, rotation, and restart`
- `81b93b9ce0` `fix(subagents): announce delivery with descendant gating, frozen result refresh, and cron retry`
- `8fce663861` `fix(subagents): harden task-registry lifecycle writes`
- `19ef298678` `fix(ci): skip reply wait for non-message subagents`

### Practical meaning

Upstream already has:

- stronger reply lifecycle handling
- cleaner follow-up delivery seams
- better queued reply runtime behavior
- subagent announce retry / descendant gating / frozen result logic
- task-registry hardening around subagent lifecycle writes

So we should **not** duplicate any of that machinery.

## What is still local right now

In the current `openclaw-src` working tree, these files are modified but not committed upstream:

- `src/agents/subagent-registry.types.ts`
- `src/agents/subagent-registry-lifecycle.ts`
- `src/agents/subagent-registry.test.ts`
- `src/agents/subagent-registry-lifecycle.test.ts`

Those local changes add:

- `pendingFinalDelivery` state on `SubagentRunRecord`
- `PendingFinalDeliveryPayload`
- resume/retry paths that prefer the durable payload over stale live fields
- cleanup that clears pending state on success / give-up

## Conclusion

The exact `pendingFinalDelivery` design is **not already done upstream**.

But the surrounding system changed enough that our local work should be framed as:

- **build on upstream lifecycle + follow-up improvements**
- **do not re-implement queued reply or reply lifecycle fixes**
- **focus only on the missing durable parent-owned final delivery obligation**

## Recommended next hardening slices

### Slice 1

Add persistence/restart coverage for `pendingFinalDelivery` payload reuse.

Why:

- this is the core stability claim of the approach
- if restart/resume is not covered, the feature is not really durable

### Slice 2

Verify success and give-up paths always clear pending state.

Why:

- otherwise stale retry obligations can survive and cause duplicate or misleading deliveries

### Slice 3

If runtime behavior is still flaky after slices 1-2, promote the obligation from a subagent-run field to a more explicit delivery queue / retry queue abstraction.

Why:

- the run record works as a lightweight durable carrier
- but a dedicated queue may become necessary if retry policy, observability, or cross-process ownership grows more complex

## Working stance for today

- continue the local `pendingFinalDelivery` line
- treat upstream as adjacent groundwork, not as a replacement
- prioritize restart durability and explicit retry semantics over new feature breadth

## Validation result from this work slice

A real restart/retry durability bug was reproduced and fixed locally:

- on a failed retry, `markPendingFinalDelivery(...)` rebuilt the payload from current live run fields
- that could overwrite the original durable payload with stale mutable values
- fix: reuse `loadPendingFinalDeliveryPayload(entry)` when re-marking pending delivery state

This keeps the durable payload stable across restart/resume cleanup attempts instead of drifting back to live fields.
