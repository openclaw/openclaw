---
summary: "Phase 1 agent-to-agent handoff contract for sessions_send acknowledgements, control-only outcomes, and audit events."
read_when:
  - Changing sessions_send agent-to-agent delivery behavior
  - Debugging silent NO_REPLY, REPLY_SKIP, or ANNOUNCE_SKIP handoff outcomes
  - Reviewing the boundary between handoff transport and meeting lifecycle
title: "Agent-to-agent handoff, Phase 1"
---

# Agent-to-agent handoff, Phase 1

OpenClaw treats `sessions_send` agent-to-agent delegation as a first-party
handoff with a stable id, a structured acknowledgement, and an append-only audit
trail. Phase 1 stays at the transport and acknowledgement layer. It does not
introduce a meeting lifecycle, durable work queue, retry engine, dashboard, or
workflow state machine.

## Contract

Every delegated `sessions_send` attempt that resolves to a target session gets
a `handoff.id`. The existing `status`, `runId`, `reply`, `sessionKey`, and
`delivery` fields stay in place for compatibility. New callers can inspect the
`handoff` envelope:

```json
{
  "runId": "run_123",
  "status": "accepted",
  "sessionKey": "agent:worker:main",
  "delivery": {
    "status": "pending",
    "mode": "announce"
  },
  "handoff": {
    "id": "8b8424a8-3b02-4c2a-9a33-7d7a99f0f4da",
    "status": "accepted",
    "delivery": {
      "status": "pending",
      "mode": "announce"
    },
    "ledger": {
      "path": "handoffs/sessions-send.jsonl"
    }
  }
}
```

The `handoff.status` field uses these Phase 1 states:

| State       | Meaning                                                                  |
| ----------- | ------------------------------------------------------------------------ |
| `queued`    | OpenClaw created the handoff record before the target run was accepted.  |
| `accepted`  | The target agent run was accepted or the request reached target runtime. |
| `delivered` | A terminal visible or control-only outcome was observed.                 |
| `rejected`  | OpenClaw rejected the handoff before target runtime accepted it.         |

## Control-only outcomes

Control-only target replies must not make transport success look like
disappeared work. Phase 1 records these outcomes in the handoff ledger and then
preserves the existing suppression behavior:

| Target output   | Recorded `controlOutcome` | Delivery behavior                               |
| --------------- | ------------------------- | ----------------------------------------------- |
| `NO_REPLY`      | `no_reply`                | Do not announce or post visible channel output. |
| `REPLY_SKIP`    | `reply_skip`              | Stop the reply-back loop without re-injection.  |
| `ANNOUNCE_SKIP` | `announce_skip`           | Skip final announce delivery.                   |
| `HEARTBEAT_OK`  | `heartbeat_ok`            | Treat as an internal heartbeat-only result.     |

## Ledger

The append-only ledger lives under the OpenClaw state directory at:

```text
handoffs/sessions-send.jsonl
```

Each JSONL entry includes `handoffId`, `type`, `status`, `timestamp`, and
available routing metadata such as requester session, requester channel, target
session, and target channel. The ledger intentionally avoids storing original
prompt or reply text.

Phase 1 events include:

| Event                      | When it is written                                                  |
| -------------------------- | ------------------------------------------------------------------- |
| `created`                  | A resolved target handoff is created.                               |
| `accepted`                 | The target `agent` call returns an accepted run id.                 |
| `rejected`                 | Validation rejects the target before target runtime.                |
| `target_reply_observed`    | The target produced a non-control reply.                            |
| `target_reply_missing`     | A delayed flow could not observe a new target reply.                |
| `control_outcome_observed` | A control-only target, reply-back, or announce result was observed. |
| `announce_delivered`       | The final announce message was sent to a channel target.            |
| `announce_delivery_failed` | Channel delivery for the announce failed.                           |
| `failed`                   | The target wait or A2A follow-up failed after acceptance.           |

Ledger writes are best-effort. A local state directory failure should not turn
an otherwise valid agent handoff into a failed `sessions_send` call.

## Non-goals

Phase 1 does not implement:

- meeting or teleconference lifecycle states such as `pending -> active -> closed`
- pickup queues or cross-agent work claiming
- one-way dispatch mode
- retry scheduling or cancellation
- transcript UI or dashboards
- database-backed orchestration

Those belong in higher layers after the handoff transport contract is stable.

## Implementation surface

The implementation is intentionally scoped to:

- `src/agents/tools/sessions-send-tool.ts` for the returned acknowledgement
- `src/agents/tools/sessions-send-tool.a2a.ts` for A2A outcome recording
- `src/agents/tools/sessions-send-handoff.ts` for handoff types and ledger writes
- focused tests around accepted sends and control-only outcomes

This keeps the primitive reusable by later meeting or teleconference work
without making `sessions_send` own the higher-level lifecycle.
