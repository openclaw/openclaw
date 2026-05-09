---
summary: "ACP streaming markers, broadcast layering, and session/load history model"
read_when:
  - Investigating log markers during ACPX channel-adapter tool deliveries
  - Debugging which runtime path produced a stream=tool event in gateway logs
  - Understanding how each channel adapter emits WS broadcast events for ACPX
  - Understanding how session/load works and how conversation history is replayed for ACP bridge vs ACPX harness sessions
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

Adapter-level delivery notes (examples — OpenClaw has many more channel plugins):

- **Discord** — delivery runs through the Discord channel adapter;
  broadcast labels appear in that adapter's send path.
- **Matrix** — delivery runs through the Matrix channel adapter;
  broadcast labels appear in that adapter's event-send path.
- **Slack** — delivery runs through the Slack channel adapter;
  broadcast labels appear in that adapter's post/update path.
- **Telegram** — delivery runs through the Telegram channel adapter;
  broadcast labels appear in that adapter's `sendMessage`/`editMessageText` path.

The same pattern applies to every other channel plugin (Mattermost, MS Teams,
WhatsApp, and so on). When adding observability for ACP tool delivery, instrument
the adapter deliver function for the channel in question rather than searching for
a shared broadcast label.

## session/load and the history model

`session/load` behavior differs between the two ACP runtime modes:

| Mode                        | session/load behavior                                                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACPX harness                | Each side maintains its own transcript. The harness replays locally from `events.jsonl`. No conversation history flows on the wire.                                                       |
| ACP bridge (`openclaw acp`) | `loadSession` replays event-ledger history (or transcript fallback) to the ACP client via `session-update` notifications. History **does** flow on the wire as ACP session-update events. |

For ACP bridge sessions, `loadSession` (`src/acp/translator.ts:725-784`) calls
`replayLedgerSession()` (L773) when the event ledger is complete, or
`replaySessionTranscript()` (L775) as a fallback, emitting
`user_message_chunk`, `tool_call`, `tool_call_update`, and
`agent_message_chunk` session-update notifications to the connected ACP
client. The transcript fallback fetches stored messages via the Gateway
`sessions.get` RPC (`src/acp/translator.ts:2022-2023`) — this is a wire
call to the Gateway, not a read from local disk.

For ACPX harness sessions the original claim holds: the wire request
includes `sessionId` plus optional setup fields (`cwd`, `mcpServers`,
`_meta`); the wire response carries config, model, and mode state; and
no conversation transcript crosses the wire. See also
[ACP compatibility matrix](/cli/acp#compatibility-matrix) for the current
`loadSession` status.

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

### Reconstruction is the harness responsibility (ACPX harness mode)

In ACPX harness mode, when OpenClaw drives `session/load`, the ACP
harness (for example Copilot) reads its own `events.jsonl` for the
given `sessionId` and rehydrates its internal state. No transcript
crosses the wire in this direction.

In ACP bridge mode the situation is reversed: OpenClaw is the
responder, and it actively replays history to the connecting ACP client
via session-update notifications (see the mode table above).

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
