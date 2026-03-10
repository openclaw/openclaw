---
summary: "Agent Core Phase 4A subplan for reducing failover and auth-profile pipeline entropy without changing policy."
owner: "liu_y"
status: "proposed"
last_updated: "2026-03-10"
title: "Agent Core Failover And Auth-Profile Pipeline Plan"
---

# Agent Core Failover And Auth-Profile Pipeline Plan

## Why this plan exists

Phase 1 through Phase 3 of the Agent Core flush / compaction boundary work have landed:

- PR #54: characterization
- PR #56: flush boundary helper consolidation
- PR #58: bounded compaction retry wait after idle timeout
- PR #61: restart drain for active embedded runs

That means the next Agent Core step should not keep stretching the flush / compaction seam.
The next highest-entropy seam is the failover and auth-profile pipeline inside the embedded runner.

Today, one path still carries too many responsibilities at once:

- auth-profile ordering and advancement
- cooldown interpretation
- failover reason classification
- prompt-error vs assistant-error handling
- timeout vs compaction-timeout distinctions
- fallback handoff to broader model fallback

The goal here is not to redesign failover policy.
The goal is to make the existing policy easier to reason about, test, and change safely.

## Current local baseline

Already landed in local repo:

- overloaded failover handling is split from generic failover semantics
- post-prompt compaction timeout is bounded and does not poison restart semantics
- restart drain now accounts for active embedded runs

These give us a stable base for a narrower cleanup pass on auth-profile and failover control flow.

## In-scope seam

Primary code paths:

- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/model-fallback.ts`
- `src/agents/model-auth.ts`
- `src/auto-reply/reply/get-reply-run.ts`
- `src/auto-reply/reply/directive-handling.auth.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`

Primary coordination points:

- `resolveAuthProfileOrder()`
- `resolveModelAuthMode()`
- `advanceAuthProfile()`
- `maybeMarkAuthProfileFailure()`
- `throwAuthProfileFailover()`
- `resolveAuthProfileFailoverReason()`
- `FailoverError` / `resolveFailoverStatus()`
- `timedOutDuringCompaction`
- session auth-profile override resolution

## Non-goals

This plan explicitly does not include:

- broad failover policy rewrites
- auth-profile storage/schema changes
- new cooldown heuristics
- provider-specific auth refresh redesigns
- channel-level reply behavior changes
- broader lifecycle contract cleanup outside the failover/auth-profile seam

## Why this seam is still high entropy

Current code mixes policy and orchestration in ways that make review harder than necessary:

- `run.ts` decides when to rotate auth profiles, when to mark failures, and when to escalate to model fallback.
- timeout and failover distinctions are partly made in `run/attempt.ts` and partly reinterpreted in `run.ts`.
- auth-profile ordering and model auth-mode resolution live in shared helpers, but the embedded runner still owns several cross-cutting decisions around when those results matter.
- session-level auth-profile overrides enter through reply-side setup, but the runner path still has to reconcile them with per-provider auth ordering and cooldown state.

The cleanup target is not “fewer lines at any cost”.
The target is clearer boundaries for who decides what.

## Boundary invariants

These invariants must hold after every step:

1. post-prompt compaction timeouts must not rotate or cooldown-poison auth profiles
2. explicit session auth-profile override precedence must remain unchanged
3. auth-profile exhaustion must still surface a structured `FailoverError` when fallback is configured
4. non-timeout auth failures must still be eligible for auth-profile failure marking
5. same-provider auth-profile rotation must remain narrower than broader model fallback
6. all-in-cooldown vs transient unavailability must remain distinguishable in logs and failover status
7. fallback abort semantics must remain explicit and not collapse timeouts into generic aborts
8. cleanup commits must preserve current user-visible behavior unless a test proves a bug

## Execution phases

### Phase 4A.1: Characterization

Goal:

- lock the current contract around auth-profile rotation, failure marking, and failover escalation before moving code

Expected output:

- no intended behavior change
- tighter tests for timeout, cooldown, and override boundaries

Candidate tests:

- `timedOutDuringCompaction` does not trigger auth-profile rotation or cooldown marking
- auth-profile exhaustion maps to the same failover reason/status as the cooldown store says
- explicit session auth-profile override keeps precedence when present
- timeout failures do not mark auth-profile failure, while auth/rate-limit failures still can
- broader model fallback still only runs after same-provider auth-profile advancement is exhausted

Regression minimum:

```bash
pnpm vitest run \
  src/agents/model-fallback.test.ts \
  src/agents/model-auth.test.ts \
  src/agents/model-auth.profiles.test.ts \
  src/agents/failover-error.test.ts \
  src/agents/pi-embedded-runner.run-embedded-pi-agent.auth-profile-rotation.e2e.test.ts
```

### Phase 4A.2: Decision helper extraction

Goal:

- separate policy decisions from runner loop orchestration without changing behavior

Expected output:

- smaller decision helpers for:
  - auth-profile failover reason resolution
  - auth-profile failure marking eligibility
  - auth-profile rotation eligibility
  - escalation boundary from profile rotation to model fallback

Acceptance:

- Phase 4A.1 tests remain green
- diff is mostly helper extraction and callsite narrowing
- runner loop becomes easier to read without changing retry order

### Phase 4A.3: Pipeline cleanup

Goal:

- tighten boundary ownership between runner auth-profile handling and broader model fallback

Expected output:

- fewer duplicated reason/classification branches
- clearer handoff between `run.ts` and `model-fallback.ts`
- narrower interface between reply-side auth-profile override resolution and runner execution

Acceptance:

- no change to configured fallback order
- no change to auth-profile override precedence
- timeout/abort semantics stay test-covered and explicit

### Phase 4A.4: Optional follow-ups

Only after the above are stable:

- provider-specific token refresh cleanup
- logging/observability cleanup for failover reason reporting
- total retry budget documentation across auth-profile rotation and broader model fallback

These should be separate issues unless the diff stays trivially reviewable.

## Recommended issue breakdown

Create and execute these in order:

1. Agent Core: characterize failover and auth-profile pipeline boundaries
2. Agent Core: extract auth-profile failover decision helpers without changing behavior
3. Agent Core: narrow runner-to-fallback handoff for auth-profile rotation

Do not open step 2 or 3 until step 1 has landed or exposed a concrete bug.

## Commit strategy

Use the same low-entropy pattern as the Phase 1 to 3 work:

1. semantic/characterization commit first
2. cleanup/extraction commit second
3. never mix a behavior change with unrelated movement unless the diff is trivially reviewable

Example commit shape:

1. `Agents: lock failover and auth-profile pipeline invariants`
2. `Agents: extract auth-profile failover decision helpers`
3. if needed, a tiny semantic fix:
   `Agents: fix <single failover/auth-profile behavior>`

## Immediate next step

Start with Phase 4A.1.

Definition of done for the first working step:

- create a local issue for failover/auth-profile characterization
- add missing characterization tests around timeout, cooldown, and override boundaries
- run the Phase 4A.1 regression minimum
- if tests expose a real bug, fix only that bug
- stop before helper extraction
