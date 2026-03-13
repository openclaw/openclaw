# Phase-2 Supplement Status Live Sampling

This note describes how to evaluate the phase-2 truthful early-status rollout for active-run supplements.

## Scope

The current phase-2 behavior is intentionally narrow:

- `interrupt` still emits a deterministic status immediately.
- `collect` and `followup` may emit an early truthful status when recent latency patterns show a visible-silence problem.
- `steer` and other corrective/parallel statuses remain suppressed for now.

## What to watch

Use `openclaw status` while exercising real message flows and look at the `Early status` section.

Key fields:

- `dominant latency`
  - Shows where recent waiting time is concentrated.
  - `runToFirstVisible` or `firstEventToFirstVisible` means early status is more relevant.
- `phase-2 supplements`
  - `eligible/sampleCount` and `hitRatePct` show how often supplement turns actually emit.
- `top skip`
  - Tells you the most common reason phase-2 supplement status did not emit.
- `status visible avg/p95`
  - Proxy for how quickly status messages reach the user when they do emit.
- `next`
  - Summarized recommendation for whether to expand active-run status, tighten semantics, or focus elsewhere first.

## Suggested live scenarios

1. Start a long-running task.
2. While it is still active, send a supplement such as:
   - a new constraint
   - a missing detail
   - a clarification that should be folded into the same task
3. Repeat with several samples so the diagnostics window is no longer sparse.

## How to interpret results

- High `phase-2 supplements` hit rate plus low `status visible` latency:
  - the rollout is working and may justify broadening supplement coverage.
- Low hit rate with `top skip=latency_priority_observe`:
  - the current dominant bottleneck is not a visible-silence window, so widening behavior is probably premature.
- Low hit rate with semantic skip reasons:
  - the next step is probably refining truthful semantics rather than enabling more statuses.
