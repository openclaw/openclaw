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
