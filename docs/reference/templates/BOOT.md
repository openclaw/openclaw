---
title: "BOOT.md Template"
summary: "Workspace template for BOOT.md"
read_when:
  - Adding a BOOT.md checklist
---

# BOOT.md

Add short, explicit instructions for what OpenClaw should do on startup (enable `hooks.internal.enabled`).
If the task sends a message, use the message tool and then reply with the exact
silent token `NO_REPLY` / `no_reply`.

## Surface policy (silent-by-default)

Boot-session outbound sends are classified as `messageClass: "boot"` and gated by
the delivery policy before they reach any channel adapter. This means:

- If no operator channel is configured (`channels.operator` unset), boot messages
  are **suppressed** — they never post to user-facing Discord threads, Telegram
  chats, or any other surface. This is the intentional default for "Back online"
  style chatter.
- If `channels.operator` is configured, boot messages are **rerouted** to that
  operator-only surface instead of the session's normal delivery context.

If you deliberately need a boot session to speak to a user-facing channel, issue
an explicit routed send through a regular (non-boot) session rather than the
boot session. Arbitrary string filtering is NOT the mechanism — the gate is on
session identity (`boot-*` / `boot:*` prefix) and, for cron, on job id.
