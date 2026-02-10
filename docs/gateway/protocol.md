---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Gateway WebSocket protocol: handshake, frames, versioning"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Implementing or updating gateway WS clients（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging protocol mismatches or connect failures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Regenerating protocol schema/models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Gateway Protocol"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Gateway protocol (WebSocket)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway WS protocol is the **single control plane + node transport** for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw. All clients (CLI, web UI, macOS app, iOS/Android nodes, headless（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
nodes) connect over WebSocket and declare their **role** + **scope** at（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
handshake time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Transport（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WebSocket, text frames with JSON payloads.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- First frame **must** be a `connect` request.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Handshake (connect)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway → Client (pre-connect challenge):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "type": "event",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "event": "connect.challenge",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "payload": { "nonce": "…", "ts": 1737264000000 }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Client → Gateway:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "type": "req",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "id": "…",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "method": "connect",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "params": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "minProtocol": 3,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "maxProtocol": 3,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "client": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "id": "cli",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "version": "1.2.3",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "platform": "macos",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "mode": "operator"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "role": "operator",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "scopes": ["operator.read", "operator.write"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "caps": [],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "commands": [],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "permissions": {},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "auth": { "token": "…" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "locale": "en-US",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "userAgent": "openclaw-cli/1.2.3",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "device": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "id": "device_fingerprint",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "publicKey": "…",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "signature": "…",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "signedAt": 1737264000000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "nonce": "…"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway → Client:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "type": "res",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "id": "…",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "ok": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a device token is issued, `hello-ok` also includes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "auth": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "deviceToken": "…",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "role": "operator",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "scopes": ["operator.read", "operator.write"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Node example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "type": "req",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "id": "…",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "method": "connect",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "params": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "minProtocol": 3,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "maxProtocol": 3,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "client": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "id": "ios-node",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "version": "1.2.3",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "platform": "ios",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "mode": "node"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "role": "node",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "scopes": [],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "caps": ["camera", "canvas", "screen", "location", "voice"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "commands": ["camera.snap", "canvas.navigate", "screen.record", "location.get"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "permissions": { "camera.capture": true, "screen.record": false },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "auth": { "token": "…" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "locale": "en-US",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "userAgent": "openclaw-ios/1.2.3",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "device": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "id": "device_fingerprint",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "publicKey": "…",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "signature": "…",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "signedAt": 1737264000000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "nonce": "…"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Framing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Request**: `{type:"req", id, method, params}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Response**: `{type:"res", id, ok, payload|error}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Event**: `{type:"event", event, payload, seq?, stateVersion?}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Side-effecting methods require **idempotency keys** (see schema).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Roles + scopes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Roles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `operator` = control plane client (CLI/UI/automation).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node` = capability host (camera/screen/canvas/system.run).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Scopes (operator)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common scopes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `operator.read`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `operator.write`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `operator.admin`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `operator.approvals`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `operator.pairing`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Caps/commands/permissions (node)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Nodes declare capability claims at connect time:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `caps`: high-level capability categories.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commands`: command allowlist for invoke.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `permissions`: granular toggles (e.g. `screen.record`, `camera.capture`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway treats these as **claims** and enforces server-side allowlists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Presence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `system-presence` returns entries keyed by device identity.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Presence entries include `deviceId`, `roles`, and `scopes` so UIs can show a single row per device（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  even when it connects as both **operator** and **node**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Node helper methods（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Nodes may call `skills.bins` to fetch the current list of skill executables（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  for auto-allow checks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Exec approvals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When an exec request needs approval, the gateway broadcasts `exec.approval.requested`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Operator clients resolve by calling `exec.approval.resolve` (requires `operator.approvals` scope).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Versioning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `PROTOCOL_VERSION` lives in `src/gateway/protocol/schema.ts`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Clients send `minProtocol` + `maxProtocol`; the server rejects mismatches.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Schemas + models are generated from TypeBox definitions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pnpm protocol:gen`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pnpm protocol:gen:swift`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pnpm protocol:check`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Auth（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `OPENCLAW_GATEWAY_TOKEN` (or `--token`) is set, `connect.params.auth.token`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  must match or the socket is closed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- After pairing, the Gateway issues a **device token** scoped to the connection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  role + scopes. It is returned in `hello-ok.auth.deviceToken` and should be（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  persisted by the client for future connects.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Device tokens can be rotated/revoked via `device.token.rotate` and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `device.token.revoke` (requires `operator.pairing` scope).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Device identity + pairing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Nodes should include a stable device identity (`device.id`) derived from a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  keypair fingerprint.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateways issue tokens per device + role.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pairing approvals are required for new device IDs unless local auto-approval（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  is enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Local** connects include loopback and the gateway host’s own tailnet address（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (so same‑host tailnet binds can still auto‑approve).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- All WS clients must include `device` identity during `connect` (operator + node).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Control UI can omit it **only** when `gateway.controlUi.allowInsecureAuth` is enabled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (or `gateway.controlUi.dangerouslyDisableDeviceAuth` for break-glass use).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Non-local connections must sign the server-provided `connect.challenge` nonce.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## TLS + pinning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TLS is supported for WS connections.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Clients may optionally pin the gateway cert fingerprint (see `gateway.tls`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  config plus `gateway.remote.tlsFingerprint` or CLI `--tls-fingerprint`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Scope（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This protocol exposes the **full gateway API** (status, channels, models, chat,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent, sessions, nodes, approvals, etc.). The exact surface is defined by the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
TypeBox schemas in `src/gateway/protocol/schema.ts`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
