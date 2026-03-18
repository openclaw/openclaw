---
summary: "Planning document for OAG runtime work: scope, tasks, and acceptance criteria"
read_when:
  - You need a more formal development plan for OAG
  - You want requirements, progress, and acceptance criteria in one place
title: "OAG Plan"
---

# OAG Plan

## Background

OAG is the runtime layer around the Gateway and agent loop that is intended to detect and respond to:

- outbound channel backlog and recovery lag
- stalled or blocked reply sessions
- stuck task follow-ups that look complete but never resolve cleanly

Before this work, most of that state was either implicit in logs or only available through sentinel-generated files. Operators did not have a clear CLI surface for understanding what OAG was doing, and user-visible recovery notices were inconsistent.

## Goals

- Surface OAG runtime state in operator-facing CLI commands.
- Make post-recovery delivery replay explicit and scoped to the recovered channel/account.
- Deliver one-shot OAG recovery notes to the correct session when the action is user-visible.
- Keep user-visible OAG notes and heartbeat prompts aligned with the session’s recent reply language when possible.
- Improve channel-health decisions by publishing clearer lifecycle state from monitor implementations.

## Non-goals

- Redesign the sentinel producer architecture.
- Replace logs with OAG summaries as the sole source of operational truth.
- Build a full end-user UI for OAG.
- Finalize every future OAG/Argus state transition in this branch.

## Functional scope

Current OAG work in this branch covers:

- `status`, `health`, and `doctor` summaries for:
  - `OAG channels`
  - `OAG sessions`
  - `OAG tasks`
- session-scoped one-shot `OAG:` system notes
- session language inference for OAG note localization and heartbeat prompt hints
- channel recovery hooks that replay pending outbound deliveries
- channel monitor lifecycle status publication for health evaluation

## Key files

- [`src/commands/oag-channel-health.ts`](/Users/henry/.openclaw/openclaw-fork/src/commands/oag-channel-health.ts)
- [`src/infra/oag-system-events.ts`](/Users/henry/.openclaw/openclaw-fork/src/infra/oag-system-events.ts)
- [`src/infra/session-language.ts`](/Users/henry/.openclaw/openclaw-fork/src/infra/session-language.ts)
- [`src/infra/heartbeat-runner.ts`](/Users/henry/.openclaw/openclaw-fork/src/infra/heartbeat-runner.ts)
- [`src/gateway/server-channels.ts`](/Users/henry/.openclaw/openclaw-fork/src/gateway/server-channels.ts)
- [`src/gateway/server.impl.ts`](/Users/henry/.openclaw/openclaw-fork/src/gateway/server.impl.ts)
- [`src/auto-reply/reply/session-updates.ts`](/Users/henry/.openclaw/openclaw-fork/src/auto-reply/reply/session-updates.ts)

## State and data dependencies

Primary runtime state currently comes from:

```text
~/.openclaw/sentinel/channel-health-state.json
```

This branch assumes that file can include channel backlog state, session watch state, task watch state, and pending user notes produced by the sentinel/watch pipeline.

## Current progress

### Completed

- OAG summaries are visible in CLI status surfaces.
- OAG runtime docs and reviewer brief now exist.
- Channel recovery can trigger scoped queued-delivery replay.
- Session updates can consume one-shot OAG notes.
- OAG notes can be localized using recent session language heuristics.
- Parser compatibility was hardened to better tolerate mixed field naming in nested sentinel payloads.
- OAG note consumption was hardened against concurrent read-modify-write races.

### In progress

- Confirming the exact sentinel producer schema in the wild.
- Validating monitor lifecycle semantics across all supported channels.
- Consolidating remaining OAG-related branch changes into clearer commits.

### Not done

- Dedicated schema documentation for sentinel-produced OAG state.
- Dedicated lifecycle documentation for Argus recovery metadata.
- Explicit acceptance tests that cover every monitor type against common health-policy failure modes.

## Work checklist

- [x] Add OAG runtime summary formatting.
- [x] Surface OAG data in `status`.
- [x] Surface OAG data in `health`.
- [x] Surface OAG data in `doctor`.
- [x] Add one-shot OAG session notes.
- [x] Add basic OAG note localization.
- [x] Replay queued deliveries on channel recovery.
- [x] Add external reviewer brief.
- [x] Add runtime operations documentation.
- [ ] Document sentinel producer schema and versioning expectations.
- [ ] Document Argus/OAG session state transitions.
- [ ] Define expected monitor lifecycle signals by channel.
- [ ] Add broader regression coverage for recovery replay under repeated flaps.
- [ ] Split broader branch work into reviewable commits.

## Acceptance criteria

The OAG work should be considered functionally acceptable when all of the following are true:

1. `openclaw status`, `openclaw health`, and `doctor` show OAG summaries without crashing when sentinel state is missing, partial, or stale.
2. A recovered channel/account only replays queued outbound deliveries for its own scope.
3. A one-shot OAG note appears only in the intended session and is not repeatedly re-injected.
4. Concurrent session replies do not corrupt the pending-note state file.
5. Missing language detection falls back safely without breaking reply generation.
6. Channel health policy can distinguish at least these cases:
   - healthy but quiet
   - disconnected
   - stale socket / stalled polling
   - temporarily busy but still alive
7. Operator-facing OAG summaries are concise enough to be useful without requiring log inspection for every healthy case.

## Review guidance

External reviewers should prioritize:

- correctness of schema handling
- concurrency safety
- recovery replay scope
- session targeting correctness
- health-policy false positives / false negatives
- user-visible regressions or noisy behavior

For a shorter handoff document, see [OAG Review Brief](/gateway/oag-review-brief).
