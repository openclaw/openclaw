# Loop Detection Consecutive Error Guard Design

## Summary

OpenClaw already detects several repeated tool-call patterns, but it does not block the case where different tools all fail back-to-back inside the same run. This design adds one new run-scoped detector, `consecutive_errors`, and deliberately does not add any turn-wide hard cap.

## Problem

The existing loop detector is strong at catching repeated identical calls and some no-progress alternation, but it misses a common failure mode:

- the agent tries tool A and gets an error
- it then tries tool B and gets an error
- it then tries tool C and gets an error
- the run keeps burning tokens even though every attempt is failing

This can happen when the underlying problem is shared across tools, such as missing permissions, a dead external dependency, or an invalid workspace assumption.

## Current Constraints

- Loop detection already supports `runId` scoping and should keep using it.
- The docs currently say history is evaluated within the current run when a `runId` is available.
- Reviewer feedback rejected the prior `max_calls_per_turn` proposal because it was not truly turn-scoped and used a 60-second wall-clock heuristic instead of real run or turn boundaries.

## Goals

- Add a critical detector for consecutive tool-call errors within the current run.
- Make the detector configurable through `tools.loopDetection.consecutiveErrorThreshold`.
- Keep the implementation aligned with existing run-scoped loop-detection semantics.
- Add tests that cover both the pure detector behavior and the actual before-tool-call hook path with `runId`.

## Non-Goals

- No `max_calls_per_turn`.
- No session-level counters.
- No wall-clock-based turn inference.
- No changes to unrelated formatting-only cleanup work.
- No Control UI/browser-bundle work; that line is already covered upstream by narrower fixes.

## Chosen Approach

### Detection Model

Add a `consecutive_errors` detector that scans the current run-scoped history tail from newest to oldest and counts consecutive entries whose `resultHash` encodes an error. The streak ends on the first success or missing outcome.

This stays consistent with the rest of loop detection:

- it works only on completed tool outcomes
- it uses the same history buffer and `runId` filtering
- it blocks only when the current tail is still failing

### Config Surface

Add one new optional config field:

- `tools.loopDetection.consecutiveErrorThreshold`

Default: `10`

No new detector toggle is needed because this is a core loop-detection threshold, not a parallel subsystem.

### Runtime Scope

The detector must run against the same scoped history returned by `selectHistoryForScope(...)`. That means:

- same session, different run: old failures do not count
- same run: consecutive failures do count
- fresh successful outcome: resets the streak naturally

### Tests

Add:

- pure detector tests in `src/agents/tool-loop-detection.test.ts`
- hook-level tests in `src/agents/pi-tools.before-tool-call.e2e.test.ts` to prove run scoping in the real path

### Docs and Changelog

Update `docs/tools/loop-detection.md` to document the new threshold and behavior. Add one Unreleased changelog fix entry because this is user-facing runtime behavior.

## Files

- Modify: `src/agents/tool-loop-detection.ts`
- Modify: `src/agents/tool-loop-detection.test.ts`
- Modify: `src/agents/pi-tools.before-tool-call.e2e.test.ts`
- Modify: `src/config/types.tools.ts`
- Modify: `src/config/zod-schema.agent-runtime.ts`
- Modify: `docs/tools/loop-detection.md`
- Modify: `CHANGELOG.md`

## Verification

Targeted local proof only:

- detector unit tests
- before-tool-call e2e tests for run scoping
- targeted docs/format checks if needed
- local build for touched runtime surface before redeploy
- local gateway restart and manual smoke that the installation still comes up cleanly

## Upstream Packaging

- Rework the local PR-002 draft into a narrower issue/PR pair focused only on consecutive cross-tool error cascades.
- Mark PR-001 as already-fixed upstream and do not submit that implementation.
- Do not submit PR-003 as a standalone upstream PR.
