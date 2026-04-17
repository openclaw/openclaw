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

## Surface policy (origin-respect, silent-by-default when unrouted)

Boot-session outbound sends are classified as `messageClass: "boot"` and gated
by the delivery policy before they reach any channel adapter. The policy
respects the surface that originated the send:

- If the boot session has a configured delivery target (i.e. the session's
  stored delivery context resolves to a real channel + address), the boot
  message is delivered there, exactly where the caller intended.
- If there is no origin surface available, the boot message is **suppressed**
  — it never posts to user-facing Discord threads, Telegram chats, or any
  other surface. This is the intentional default for "Back online" style
  chatter when no explicit destination was configured.

If you deliberately need a boot session to speak to a channel, configure its
delivery context (or emit through a regular non-boot session). Arbitrary
string filtering is NOT the mechanism — the gate is on session identity
(`boot-*` / `boot:*` prefix) and, for cron, on the job's own `delivery`
target.
