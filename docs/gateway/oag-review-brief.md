---
summary: "Brief for external reviewers auditing OAG runtime code"
read_when:
  - You want to send OAG code to another tool or reviewer
  - You need a concise feature brief plus review checklist
title: "OAG Review Brief"
---

# OAG Review Brief

## Repository path

```text
/Users/henry/.openclaw/openclaw-fork
```

## Primary code paths

```text
/Users/henry/.openclaw/openclaw-fork/src/commands/oag-channel-health.ts
/Users/henry/.openclaw/openclaw-fork/src/infra/oag-system-events.ts
/Users/henry/.openclaw/openclaw-fork/src/infra/session-language.ts
/Users/henry/.openclaw/openclaw-fork/src/infra/heartbeat-runner.ts
/Users/henry/.openclaw/openclaw-fork/src/gateway/server-channels.ts
/Users/henry/.openclaw/openclaw-fork/src/gateway/server.impl.ts
/Users/henry/.openclaw/openclaw-fork/src/auto-reply/reply/session-updates.ts
```

## Standard feature summary

OAG is the runtime layer around the Gateway and agent loop that watches channel delivery pressure, stalled sessions, and stuck task follow-ups, then surfaces that state in operator-facing CLI commands and selected user-visible recovery notes.

Current intended behavior:

- Read channel/session/task watch state from `~/.openclaw/sentinel/channel-health-state.json`.
- Surface summarized OAG state in `openclaw status`, `openclaw health`, and `doctor`.
- When a channel becomes operational again, replay queued outbound deliveries for that specific channel/account.
- When OAG performs a user-relevant recovery action, inject a one-shot `OAG:` system note into the next matching session reply.
- Localize OAG user-visible notes and heartbeat prompts to the recent reply language of the target session when possible.
- Publish enough channel monitor lifecycle state that health policy can distinguish a healthy quiet channel from a dead socket or stalled polling loop.

## Development requirements

The current branch is trying to satisfy these concrete requirements:

- Expose OAG runtime state through operator-facing CLI surfaces instead of leaving it buried in sentinel state files.
- Make channel recovery actionable by replaying queued outbound deliveries after the affected channel/account becomes healthy again.
- Deliver OAG recovery notes to the correct user session exactly once when the recovery action is user-visible.
- Keep OAG notes and heartbeat user-facing text aligned with the session’s recent reply language when detection is possible.
- Feed channel health policy with enough lifecycle data from each monitor to reduce false restart decisions.

## Current progress

Approximate status for this branch:

- Done:
  OAG summaries are wired into `status`, `health`, and `doctor`.
- Done:
  Channel recovery hooks can replay pending outbound deliveries for a recovered channel/account.
- Done:
  OAG one-shot notes can be injected into session updates and localized using recent session language.
- Done:
  Review brief and runtime docs now exist for external reviewers.
- In progress:
  Sentinel schema compatibility and runtime behavior are still being validated against real producer output.
- In progress:
  The implementation is spread across several uncommitted branch changes outside the narrow OAG parsing/docs fix.

## Task checklist

- [x] Add OAG channel/session/task summaries to operator-facing status surfaces.
- [x] Add user-visible OAG recovery notes for matching sessions.
- [x] Add localized fallback behavior for OAG notes and heartbeat output.
- [x] Add channel recovery replay for pending outbound deliveries.
- [x] Add external review brief and runtime documentation.
- [ ] Document the sentinel producer schema in one place.
- [ ] Document the Argus session metadata lifecycle and recovery state transitions.
- [ ] Define acceptance criteria for monitor lifecycle signals across all supported channels.
- [ ] Consolidate the remaining OAG branch work into a cleaner set of commits.

## Review instructions

Please review OAG with emphasis on correctness and operational safety rather than style.

Priority review areas:

- State schema handling:
  Confirm that JSON read paths accept the producer schema actually emitted by the sentinel/watch pipeline, including nested field naming and optional fields.

- Concurrency and durability:
  Check whether concurrent session replies, channel recovery hooks, or monitor updates can lose state, replay notes incorrectly, or race queued-delivery recovery.

- Recovery scope:
  Verify that channel recovery only replays deliveries for the recovered channel/account and does not cause duplicate sends or cross-account leakage.

- Session targeting:
  Confirm that one-shot OAG notes only appear in the intended session and are consumed exactly once.

- Health semantics:
  Check whether connected/disconnected/inbound activity updates across Telegram, Signal, LINE, iMessage, and other monitors are enough to support the channel health policy without false positives.

- Localization heuristics:
  Review whether reply-language inference is conservative enough and whether fallback behavior is safe when language detection fails.

- User-visible regressions:
  Look for any path where OAG system notes, heartbeat prompts, or status output could become noisy, misleading, or repeated.

## Requested review output

Please return:

- concrete bugs or behavioral regressions first
- missing tests or weak assumptions second
- only brief summary after findings

If possible, include file paths and line references for each issue.
