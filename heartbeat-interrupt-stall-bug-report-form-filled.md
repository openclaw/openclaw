# Bug type

Behavior bug (incorrect output/state without crash)

# Beta release blocker

No

# Summary

In direct main-session use on 2026-04-12, heartbeat prompts and system events such as `Exec completed (...)` were observed to interrupt longer multi-step tasks, and the original user request sometimes did not receive a final reply until the user sent another message.

# Steps to reproduce

1. Start a longer multi-step task in the main session.
2. Let the task run long enough that heartbeat prompts or `Exec completed (...)` system events can arrive in the same session.
3. Observe whether the assistant handles the interrupting event.
4. Observe whether the original task fails to produce a final user-visible reply until the user nudges again.

# Expected behavior

The original main-session user task should still produce a final user-visible reply after heartbeat/system-event interrupts, without requiring a manual follow-up message from the user.

# Actual behavior

On 2026-04-12 in this session, heartbeat prompts were answered with `HEARTBEAT_OK`, system exec-completion events were also emitted, and the user repeatedly had to send follow-up messages such as "yine takıldın" before the original task continued to a final reply.

# OpenClaw version

2026.4.9 (253ecd2)

# Operating system

Linux 6.6.114.1-microsoft-standard-WSL2

# Install method

npm global (under `~/.nvm/versions/node/v22.22.2/lib/node_modules/openclaw`)

# Model

openai/gpt-5.4

# Provider / routing chain

openclaw -> openai

# Additional provider/model setup details

Session status showed `Model: openai/gpt-5.4 · api-key (openai:default)` during investigation.

# Logs, screenshots, and evidence

```text
Observed in the same direct session on 2026-04-12.

Examples of interrupting events seen during the session:
- heartbeat prompt turns that required replying `HEARTBEAT_OK`
- system events such as `Exec completed (...)` and `Exec failed (...)`

Observed user-visible consequence:
- after interrupting events, the user repeatedly had to send messages like:
  - "yine takıldın"
  - "ne yaptın yarım saattir çalışıyorsun neden dönüş yapamadın ?"

Observed follow-up behavior:
- the original task often resumed only after the user nudged again

Relevant local investigation notes:
- `pending-final-delivery-vs-heartbeat-stall-investigation.md`
- `heartbeat-interrupt-stall-minimal-repro.md`
```

# Impact and severity

Affected: direct main-session tasks interrupted by heartbeat/system events
Severity: High (final user-visible reply can be lost or delayed until manual follow-up)
Frequency: Observed multiple times in one session on 2026-04-12
Consequence: the session appears stuck and the user has to manually nudge for completion

# Additional information

This appears different from the recent subagent `pendingFinalDelivery` fixes, which are tied to `SubagentRunRecord` completion delivery state. Related but not identical issues: `#29762` and `#14191`.
