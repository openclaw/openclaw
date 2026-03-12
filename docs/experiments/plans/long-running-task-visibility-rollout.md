# Long-Running Task Visibility Rollout Plan

## Goal

Land long-running task visibility as an incremental upstream-friendly change,
without coupling it to the in-progress supervisor expansion work.

## Key Architectural Decision

The first implementation seam should be **reply delivery**, not only
`get-reply-run`.

Reason:

- `get-reply-run` can see planning and scheduling intent
- but it does not own every actual user-visible delivery path
- the reply delivery layer already serializes block/final output and is the
  natural place to observe the first payload that actually becomes visible

This matters because the long-term contract is:

- measure and govern `dispatch -> first visible output`

not:

- measure only planned supervisor intermediate messages

## Phase Split

### Phase 0: Design and scope

Already covered by:

- `docs/design/long-running-task-visibility.md`
- `docs/design/long-running-task-visibility-technical.md`

### Phase 1: Delivery-layer observability

Add first-visible measurement without changing user-visible behavior.

Preferred touch points:

- `src/auto-reply/reply/reply-dispatcher.ts`
- `src/auto-reply/reply/dispatch-from-config.ts`
- channel dispatchers only where channel-specific visibility needs special
  interpretation

Deliverables:

- a reply-dispatch lifecycle hook or callback for first successful visible
  delivery
- timing from dispatch start to first visible reply delivery
- timing from first visible delivery to final completion where possible

Why this is a clean first increment:

- low user-facing behavior risk
- useful observability immediately
- avoids binding the feature to any single channel or presentation planner

### Phase 2: Minimal watchdog

Only after phase-1 observability exists.

Preferred ownership:

- runtime turn orchestration starts the watchdog
- supervisor planner supplies semantically valid `status`
- reply delivery resolves the watchdog once visibility actually happens

Deliverables:

- deterministic early `status` when already semantically eligible
- lightweight `ack` fallback when no `status` is available
- no behavior change for fast-completing turns

### Phase 3: Richer progress alignment

Later work:

- specialist-startup visibility
- milestone timing integration
- channel-tuned thresholds
- explicit `final` visibility accounting where channel renderers differ

## Why Not Start in Supervisor

Supervisor is the correct place to answer:

- what kind of progress message is semantically valid

It is not the best place to answer:

- what the user actually saw first

If phase 1 is implemented only in supervisor scheduling, it risks measuring:

- planned intermediate output

instead of:

- actual visible delivery

That would weaken the value of the metric and create false certainty.

## Separation of Concerns

The implementation should keep these layers distinct:

### Physical/runtime layer

- dispatch start time
- first visible delivery detection
- watchdog timing
- outcome signals

### Presentation semantics layer

- `ack/status/milestone/final`
- whether `status` or `milestone` is valid for the current turn
- truthful wording constraints

### Model workaround layer

- temporary protections for current model behavior
- no silent fallback after specialist/backend failure

Only the first two belong in the generic upstream implementation.

## Suggested First PR Shape

A clean first implementation PR should ideally include:

1. outcome signal additions for first-visible delivery
2. reply-dispatch lifecycle plumbing
3. tests proving:
   - first visible delivery is recorded once
   - fast-completing turns can skip extra visibility
   - no user-visible behavior changes are required yet

This keeps the first implementation:

- measurable
- reviewable
- low risk

## Follow-Up Constraint

Do not tie phase-1 delivery observability to:

- Feishu card streaming only
- supervisor milestone generation
- ACP-only turns

The contract should remain shared across channels and execution modes.
