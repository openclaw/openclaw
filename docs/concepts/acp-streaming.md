---
summary: "ACP streaming markers, broadcast layering, and session/load history model"
read_when:
  - Investigating log markers during ACPX channel-adapter tool deliveries
  - Debugging which runtime path produced a stream=tool event in gateway logs
  - Understanding how each channel adapter emits WS broadcast events for ACPX
  - Understanding how session/load works and why conversation history is not carried on the wire
title: "ACP streaming and session model"
---

# ACP streaming and session model

This page clarifies three commonly misunderstood aspects of ACP delivery:
the meaning of `stream=tool` log markers, the per-channel broadcast layer,
and how `session/load` handles conversation history.

## Streaming markers and the channel-adapter delivery boundary

`stream=tool` is **not an ACPX channel-adapter delivery marker**.

The marker appears in multiple runtime paths: it originates in the
embedded PI runtime (`src/agents/pi-embedded-subscribe.handlers.tools.ts`),
in the native Codex app-server (`extensions/codex/src/app-server/run-attempt.ts`
and `event-projector.ts`), and the ACP bridge itself reads `stream === "tool"`
in `src/acp/translator.ts` to route tool-result callbacks. Seeing `stream=tool`
in gateway logs therefore does not uniquely identify the ACPX harness path.

What distinguishes ACPX channel-adapter delivery is the per-adapter broadcast
path that begins at the `options.deliver` callback, not a shared `stream=tool`
label. The ACPX delivery route is:

```
ACPX harness → dispatcher.sendToolResult(payload)
                 → enqueue("tool", payload)   [reply-dispatcher.ts:309]
                 → options.deliver callback   [reply-dispatcher.ts:264]
                 → channel-specific adapter delivery
```

There is no `stream=tool` emitted by the channel adapters themselves for
ACPX tool results. If you are tracing an ACPX tool delivery and see
`stream=tool` in logs, the event is from another producer (PI, native Codex,
or the ACP bridge callback layer), not from the channel-adapter broadcast.
Narrow your log search to the adapter deliver callsite for the channel in
question.

**Future work:** centralizing ACPX adapter broadcast labels into a single
marker layer would make cross-channel tracing easier. Today, instrument the
adapter deliver function per-channel instead.

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

The wire request includes `sessionId` plus optional setup fields
(`cwd`, `mcpServers`, `_meta`). The wire response carries config,
model, and mode state. No conversation transcript is exchanged between
OpenClaw and the ACP harness on the wire during `session/load`.

History reconstruction happens locally on each side: the ACPX harness
replays its own `events.jsonl`, and the OpenClaw bridge reads its
own ledger or session transcript (see `src/acp/translator.ts` —
`loadSession` drives ledger or transcript replay entirely from
locally stored state, not from wire payload).

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
