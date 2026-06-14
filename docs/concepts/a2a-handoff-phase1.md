# Agent-to-agent handoff, Phase 1

## Summary

Introduce a minimal, first-party handoff protocol for agent-to-agent messaging so `sessions_send` no longer relies on silent or ambiguous outcomes when one agent delegates work to another.

Phase 1 is intentionally small. It formalizes delivery and acknowledgement, without introducing a full workflow engine.

## Problem

Today, agent-to-agent delegation can succeed transport-wise while still being hard to reason about operationally:

- handoffs can be mistaken for silent control results
- the sender may not receive a clear accepted vs queued vs rejected outcome
- runtime verification often falls back to log or bundle inspection
- recovery after package replacement can depend on local hot patches rather than first-party behavior

This makes delegation less trustworthy than it should be for real multi-agent work.

## Proposal

Add a minimal formal handoff layer to the existing agent-to-agent path:

1. Generate a `handoff_id` for every delegated agent-to-agent send.
2. Return a structured acknowledgement envelope.
3. Distinguish at least these states:
   - `delivered`
   - `accepted`
   - `queued`
   - `rejected`
4. Preserve these outcomes even when the target side emits control-like results such as `NO_REPLY`, `REPLY_SKIP`, or `ANNOUNCE_SKIP`.
5. Write an append-only handoff ledger event stream for basic auditability.

## Why Phase 1 only

This proposal does **not** attempt to ship:

- full workflow orchestration
- retries
- cancellation
- dashboards
- durable queue management
- database-backed state machines

Those may be useful later, but they should follow only after a minimal protocol proves itself in real usage.

## Expected behavior

A sender using agent-to-agent delegation should be able to rely on these guarantees:

- a stable `handoff_id` exists for the delegation attempt
- the sender gets a structured outcome instead of ambiguous silence
- the runtime distinguishes accepted work from rejected work
- basic ledger events can be inspected for debugging and verification

## Suggested implementation seam

A natural first landing zone appears to be the existing `sessions_send` helper and A2A flow, with the protocol surfaced through the current delegation path rather than a brand new subsystem.

## Acceptance criteria

Phase 1 should be considered done when:

- `handoff_id` is present for agent-to-agent delegation
- acknowledgements expose `delivered`, `accepted`, `queued`, and `rejected`
- control-only target outcomes no longer erase handoff visibility
- the ledger path is documented and stable
- automated tests cover the happy path and silent-control regressions

## Non-goals

- replacing all existing async agent coordination
- designing a generalized workflow engine
- shipping every future handoff state up front

## Rollout recommendation

1. Land protocol primitives in first-party source.
2. Add regression tests around silent-control handling.
3. Ship as a small protocolized improvement to existing delegation.
4. Revisit Phase 2 only after real usage shows where queued/busy/retry semantics are still insufficient.
