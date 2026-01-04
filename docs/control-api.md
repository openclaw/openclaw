---
summary: "Deprecated newline-delimited control channel API (pre-gateway)"
read_when:
  - Maintaining legacy control channel support
---
# Control channel API (newline-delimited JSON)

**Deprecated (historical):** superseded by the WebSocket Gateway protocol (`clawdbot gateway`, see `docs/architecture.md` and `docs/gateway.md`).
Current builds use a WebSocket server on `ws://127.0.0.1:18789` and do **not** expose this TCP control channel.

Legacy endpoint (if present in an older build): `127.0.0.1:18789` (TCP, localhost only), typically reached via SSH port forward in remote mode.

## Frame format
Each line is a JSON object. Two shapes exist:
- **Request**: `{ "type": "request", "id": "<uuid>", "method": "health" | "status" | "last-heartbeat" | "set-heartbeats" | "ping", "params"?: { ... } }`
- **Response**: `{ "type": "response", "id": "<same id>", "ok": true, "payload"?: { ... } }` or `{ "type": "response", "id": "<same id>", "ok": false, "error": "message" }`
- **Event**: `{ "type": "event", "event": "heartbeat" | "gateway-status" | "log", "payload": { ... } }`

## Methods
- `ping`: sanity check. Payload: `{ pong: true, ts }`.
- `health`: returns the gateway health snapshot (same shape as `clawdbot health --json`).
- `status`: shorter summary (linked/authAge/heartbeatSeconds, session counts).
- `last-heartbeat`: returns the most recent heartbeat event the gateway has seen.
- `set-heartbeats { enabled: boolean }`: toggle heartbeat scheduling.

## Events
- `heartbeat` payload:
  ```json
  {
    "ts": 1765224052664,
    "status": "sent" | "ok-empty" | "ok-token" | "skipped" | "failed",
    "to": "+15551234567",
    "preview": "Heartbeat OK",
    "hasMedia": false,
    "durationMs": 1025,
    "reason": "<error text>" // only on failed/skipped
  }
  ```
- `gateway-status` payload: `{ "state": "starting" | "running" | "restarting" | "failed" | "stopped", "pid"?: number, "reason"?: string }`
- `log` payload: arbitrary log line; optional, can be disabled.

## Suggested client flow
1) Connect (or reconnect) → send `ping`.
2) Send `health` and `last-heartbeat` to populate UI.
3) Listen for `event` frames; update UI in real time.
4) For user toggles, send `set-heartbeats` and await response.

## Backward compatibility
- If the control channel is unavailable: that’s expected on modern builds. Use the Gateway WS protocol instead.
