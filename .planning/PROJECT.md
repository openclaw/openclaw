# OpenClaw Platform

## What This Is

OpenClaw is an AI assistant that runs on your devices, in your channels, with your rules. It is a personal assistant that is easy to use, supports a wide range of platforms, and respects privacy and security. It can run real tasks on a real computer — from personal automation to collaborative team work through shared Gateways.

## Core Value

A powerful AI assistant that actually does things: runs tasks, integrates with channels, and respects user privacy/security with strong defaults.

## Business Context

<!-- Internal project — no monetization, delete if this changes -->

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] **TALK-01**: Queued consult with empty completion does not lose follow-up runId
- [ ] **TALK-02**: Unmatched-event buffer is bounded to prevent unbounded memory growth
- [ ] **TALK-03**: retiredFollowupRunIds is plumbed through maintenance timers and request context types
- [ ] **TALK-04**: Gateway-backed result correlation replaces insecure acceptingAnyRunId wildcard
- [ ] **TALK-05**: Regression tests cover follow-up runId recovery and buffer bounds

### Out of Scope

- **Real-time chat**: High complexity, not core to this fix's scope
- **Video/audio streaming**: Storage/bandwidth costs, defer to future work
- **Multi-provider model support**: Already handled by existing provider subsystem; not in scope for this talk fix

## Context

The current branch `fix/talk-queued-consult-empty-completion-142080` is follow-up work on PR #142080 (`fix(talk): do not treat queued consult as empty completion`). The root fix addressed a scenario where a queued consult that receives an empty completion would lose the follow-up runId, breaking subsequent routing. This branch adds regression tests and plumbs `retiredFollowupRunIds` through the runtime lifecycle chain.

Recent commits show a chain of fixes:

- `fix(talk): correlate queued follow-up via accepting any runId after pending`
- `fix(talk): replace insecure acceptingAnyRunId wildcard with Gateway-backed result correlation`
- `fix(talk): observe delayed follow-up allocation and forward lifecycle in collect batches`
- `fix(talk): extract chat handler with answer-recovery buffer (P2 finding #2)`
- `fix(talk): preserve follow-up runId after queue settlement + bound unmatched-event buffer`
- `fix(talk): address ClawSweeper P2 findings - restore type-check contract`

The AGENTS.md repair doctrine emphasizes: reproduce the defect before editing, trace the violated invariant through its owner and callers, and prove the repaired boundary with regression tests.

Key subsystems involved:

- **Gateway**: The shared session layer for team assistants
- **Talk**: The conversation/chat subsystem handling multi-turn interactions
- **Channels**: Transport-only layer for messaging platforms
- **Agents**: The agent harness and lifecycle management

## Constraints

- **TypeScript ESM, strict types**: No `@ts-nocheck`, suppressions must protect intentional exceptions
- **AGENTS.md governance**: One PR = one issue/topic; no unrelated fixes bundled
- **SQLite for runtime state**: Not new JSON/JSONL/sidecar stores
- **Repair doctrine**: Reproduce → trace → fix at producer/lifecycle owner → prove with regression test

## Key Decisions

| Decision                                 | Rationale                                                                | Outcome |
| ---------------------------------------- | ------------------------------------------------------------------------ | ------- |
| Keep work scoped to talk/queue subsystem | AGENTS.md: one PR = one issue; avoid bundling unrelated fixes            | ✓ Good  |
| Bound unmatched-event buffer             | P2 finding: unbounded buffer can cause memory exhaustion                 | ✓ Good  |
| Gateway-backed result correlation        | Replaces insecure `acceptingAnyRunId` wildcard with explicit correlation | ✓ Good  |

---

_Last updated: 2026-09-10 after initial project setup_
