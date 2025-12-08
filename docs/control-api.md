# Control channel API (newline-delimited JSON)

Endpoint: `127.0.0.1:18789` (TCP, localhost only). Clients reach it via SSH port forward in remote mode.

## Frame format
Each line is a JSON object. Two shapes exist:
- **Request**: `{ "type": "request", "id": "<uuid>", "method": "health" | "status" | "last-heartbeat" | "set-heartbeats" | "ping", "params"?: { ... } }`
- **Response**: `{ "type": "response", "id": "<same id>", "ok": true, "payload"?: { ... } }` or `{ "type": "response", "id": "<same id>", "ok": false, "error": "message" }`
- **Event**: `{ "type": "event", "event": "heartbeat" | "relay-status" | "log", "payload": { ... } }`

## Methods
- `ping`: sanity check. Payload: `{ pong: true, ts }`.
- `health`: returns the relay health snapshot (same shape as `clawdis health --json`).
- `status`: shorter summary (linked/authAge/heartbeatSeconds, session counts).
- `last-heartbeat`: returns the most recent heartbeat event the relay has seen.
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
- `relay-status` payload: `{ "state": "starting" | "running" | "restarting" | "failed" | "stopped", "pid"?: number, "reason"?: string }`
- `log` payload: arbitrary log line; optional, can be disabled.

## Suggested client flow
1) Connect (or reconnect) → send `ping`.
2) Send `health` and `last-heartbeat` to populate UI.
3) Listen for `event` frames; update UI in real time.
4) For user toggles, send `set-heartbeats` and await response.

## Backward compatibility
- If the control port is unavailable (older relay), the client may fall back to the legacy CLI path, but the intended path is to rely solely on this API.
