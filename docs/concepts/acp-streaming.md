---
summary: "ACP streaming markers, broadcast layering, and session/load history model"
read_when:
  - Investigating log markers during ACP tool deliveries
  - Debugging why stream=tool does not appear for ACP turns
  - Understanding how each channel adapter emits WS broadcast events for ACP
  - Understanding how session/load works and why conversation history is not on the wire
title: "ACP streaming and session model"
---

# ACP streaming and session model

This page clarifies three commonly misunderstood aspects of ACP delivery:
the meaning of `stream=tool` log markers, the per-channel broadcast layer,
and how `session/load` handles conversation history.

## Streaming markers and the PI boundary

`stream=tool` is a **PI agent marker**, not an ACP marker.

It originates from `src/agents/pi-embedded-subscribe.handlers.tools.ts`,
which handles tool events for the embedded PI runtime. When you see
`stream=tool` in gateway logs, the event is on the PI path.

ACP tool deliveries follow a different route:

```
ACP harness → dispatcher.sendToolResult(payload)
                → enqueue("tool", payload)   [reply-dispatcher.ts:309]
                → options.deliver callback   [reply-dispatcher.ts:264]
                → channel-specific adapter delivery
```

There is no `stream=tool` emitted for ACP tool results. Each channel
adapter emits its own log markers when it broadcasts to WebSocket. If
you are tracing an ACP tool delivery and see no `stream=tool`, that is
correct and expected.

**Future work:** centralizing ACP broadcast labels into a single marker
layer (similar to the PI path) would make cross-channel tracing easier.
Today, narrow your log search to the adapter delivery callsite instead.

## Broadcast layering: per-channel, not centralized

ACP has **no centralized WebSocket broadcast layer**. Each channel adapter
owns its delivery path and emits its own log markers.

The shared plumbing stops at `options.deliver` in `reply-dispatcher.ts`.
After that callback, delivery is adapter-specific.

Adapter-level delivery notes:

- **Discord** — delivery runs through the Discord channel adapter;
  broadcast labels appear in that adapter's send path.
- **Matrix** — delivery runs through the Matrix channel adapter;
  broadcast labels appear in that adapter's event-send path.
- **Slack** — delivery runs through the Slack channel adapter;
  broadcast labels appear in that adapter's post/update path.
- **Telegram** — delivery runs through the Telegram channel adapter;
  broadcast labels appear in that adapter's `sendMessage`/`editMessageText` path.

When adding observability for ACP tool delivery, instrument the adapter
deliver function for the channel in question rather than searching for a
shared broadcast label.

## session/load and the history model

`session/load` does **not** carry conversation history on the wire.

The wire request contains only `sessionId`. The wire response carries
config, model, and mode state. No transcript flows between OpenClaw
and the ACP harness during `session/load`.

### Parallel transcripts

Each side stores its own transcript independently:

| Side              | Path                                                               | Role                       |
| ----------------- | ------------------------------------------------------------------ | -------------------------- |
| Copilot (harness) | `~/.copilot/session-state/<acp_session_id>/events.jsonl`           | Source of truth for replay |
| OpenClaw          | `~/.openclaw/agents/<agentId>/sessions/<openclaw-sessionId>.jsonl` | Parallel transcript        |

Replace `~/.copilot` and `~/.openclaw` with the actual config roots for
your install. In gateway environments, these default to
`<config-root>/copilot/session-state/` and `<config-root>/openclaw/agents/`
respectively.

### Reconstruction is the harness responsibility

When OpenClaw drives `session/load`, the ACP harness (for example
Copilot) reads its own `events.jsonl` for the given `sessionId` and
rehydrates its internal state. The transcript never crosses the wire.

### Session join model

Three identifiers participate in an ACP session:

| Identifier                       | Where it lives                                    | What it is                                                            |
| -------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| OpenClaw session key             | OpenClaw session store                            | Composite key `agent:<agentId>:acp:<uuid>`                            |
| OpenClaw session id              | OpenClaw session store                            | Filename of the parallel transcript, e.g. `<uuid>.jsonl`              |
| ACP session id (`acpxSessionId`) | `acp.identity.acpxSessionId` on the session entry | Copilot directory name; the `acp_session_id` passed in `session/load` |

Join field: `acp.identity.acpxSessionId` on the OpenClaw session store
entry links the OpenClaw session key to the upstream harness session.

To trace a full round-trip:

1. Look up the OpenClaw session by key (`agent:<agentId>:acp:<uuid>`).
2. Read `acp.identity.acpxSessionId` to get the upstream session id.
3. Find the harness transcript at `<harness-config-root>/session-state/<acpxSessionId>/events.jsonl`.

## Related

- [ACP agents](/tools/acp-agents) - session lifecycle, spawn, and delivery model
- [ACP agents setup](/tools/acp-agents-setup) - plugin setup and permissions
- [Streaming and chunking](/concepts/streaming) - channel-level block streaming and preview streaming
- [Messages](/concepts/messages) - message lifecycle and delivery
