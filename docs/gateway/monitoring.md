---
summary: "Monitoring patterns for OpenClaw gateways, channels, and sessions"
read_when:
  - Running OpenClaw on a server (always-on)
  - Diagnosing “agent is working but chat didn’t reply”
  - You want simple alerting on stuck sessions
title: "Monitoring"
---

# Monitoring

OpenClaw includes basic health checks and a Control UI, but long-running gateways often need deeper visibility:

- What session is active (and for which channel/account/peer)?
- Did the Gateway receive the inbound message?
- Is the agent still working, stalled, or dead?
- Did the reply get delivered (or did the channel drop)?

This page summarizes practical monitoring patterns and a community tool that covers gaps in the built-in UX.

## Built-in monitoring (first line of defense)

- `openclaw status` / `openclaw status --deep` — quick summary + per-channel probes when supported.
- `openclaw health --json` — machine-readable gateway health snapshot.
- `openclaw channels status --probe` — channel runtime/probe summary.
- `openclaw logs --follow` — when you need to prove where a message got stuck (inbound vs dispatch vs outbound).

Start with [Health Checks](/gateway/health) and [Logging](/gateway/logging).

## Common gaps (why people build monitors)

Depending on your channel mix and agent workload, it’s common to hit cases like:

- Channel looks “OK”, but inbound polling stalls intermittently (e.g. long-polling).
- An agent is working, but the reply never shows up in chat (delivery failure, routing mismatch, or thread binding).
- The Gateway is down, but you still want to see what the agent was last doing from on-disk session state.
- You want an always-on “stuck session” alert (no feedback for N minutes) without scraping logs.

## Community tool: ClawMonitor (session-focused TUI/CLI)

[ClawMonitor](https://github.com/openclawq/clawmonitor) is a community-built monitor focused on real-time, per-session visibility:

- Shows **last inbound user** + **last outbound assistant** message previews (timestamps)
- Infers work state (WORKING / FINISHED / INTERRUPTED / NO_MESSAGE) and flags **NO_FEEDBACK**
- Works in “offline mode” (reads session `*.jsonl.lock` and related state even if the Gateway is down)
- Optional correlation with gateway logs + channel runtime snapshots (Telegram/Feishu-focused rules)
- Can “nudge” a session (send a progress request) via `chat.send`

Quick start:

```bash
pip install clawmonitor
clawmonitor init
clawmonitor tui
```

If you maintain an always-on OpenClaw instance, ClawMonitor is especially useful as a “second window” while you debug channel-level issues.

## Next steps

- If you need metrics/telemetry (Prometheus / OpenTelemetry), consider shipping a lightweight exporter that consumes `openclaw health --json`.

