---
summary: "Gateway WebSocket protocol: handshake, frames, versioning"
read_when:
  - Implementing or updating gateway WS clients
  - Debugging protocol mismatches or connect failures
  - Regenerating protocol schema/models
title: "Gateway Protocol"
---

# Gateway protocol (WebSocket)

The Gateway WS protocol is the **single control plane + node transport** for
OpenClaw. All clients (CLI, web UI, macOS app, iOS/Android nodes, headless
nodes) connect over WebSocket and declare their **role** + **scope** at
handshake time.

## Transport

- WebSocket, text frames with JSON payloads.
- First frame **must** be a `connect` request.

## Handshake (connect)

Gateway → Client (pre-connect challenge):

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

Client → Gateway:

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "cli",
      "version": "1.2.3",
      "platform": "macos",
      "mode": "operator"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "caps": [],
    "commands": [],
    "permissions": {},
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-cli/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

Gateway → Client:

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }
}
```

When a device token is issued, `hello-ok` also includes:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

During trusted bootstrap handoff, `hello-ok.auth` may also include additional
bounded role entries in `deviceTokens`:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "node",
    "scopes": [],
    "deviceTokens": [
      {
        "deviceToken": "…",
        "role": "operator",
        "scopes": ["operator.approvals", "operator.read", "operator.write"]
      }
    ]
  }
}
```

### Node example

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "ios-node",
      "version": "1.2.3",
      "platform": "ios",
      "mode": "node"
    },
    "role": "node",
    "scopes": [],
    "caps": ["camera", "canvas", "screen", "location", "voice"],
    "commands": ["camera.snap", "canvas.navigate", "screen.record", "location.get"],
    "permissions": { "camera.capture": true, "screen.record": false },
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-ios/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

## Framing

- **Request**: `{type:"req", id, method, params}`
- **Response**: `{type:"res", id, ok, payload|error}`
- **Event**: `{type:"event", event, payload, seq?, stateVersion?}`

Side-effecting methods require **idempotency keys** (see schema).

## Roles + scopes

### Roles

- `operator` = control plane client (CLI/UI/automation).
- `node` = capability host (camera/screen/canvas/system.run).

### Scopes (operator)

Common scopes:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

Plugin-registered gateway RPC methods may request their own operator scope, but
reserved core admin prefixes (`config.*`, `exec.approvals.*`, `wizard.*`,
`update.*`) always resolve to `operator.admin`.

Method scope is only the first gate. Some slash commands reached through
`chat.send` apply stricter command-level checks on top. For example, persistent
`/config set` and `/config unset` writes require `operator.admin`.

`node.pair.approve` also has an extra approval-time scope check on top of the
base method scope:

- commandless requests: `operator.pairing`
- requests with non-exec node commands: `operator.pairing` + `operator.write`
- requests that include `system.run`, `system.run.prepare`, or `system.which`:
  `operator.pairing` + `operator.admin`

### Caps/commands/permissions (node)

Nodes declare capability claims at connect time:

- `caps`: high-level capability categories.
- `commands`: command allowlist for invoke.
- `permissions`: granular toggles (e.g. `screen.record`, `camera.capture`).

The Gateway treats these as **claims** and enforces server-side allowlists.

## Presence

- `system-presence` returns entries keyed by device identity.
- Presence entries include `deviceId`, `roles`, and `scopes` so UIs can show a single row per device
  even when it connects as both **operator** and **node**.

### Node helper methods

- Nodes may call `skills.bins` to fetch the current list of skill executables
  for auto-allow checks.

### Operator helper methods

- Operators may call `tools.catalog` (`operator.read`) to fetch the runtime tool catalog for an
  agent. The response includes grouped tools and provenance metadata:
  - `source`: `core` or `plugin`
  - `pluginId`: plugin owner when `source="plugin"`
  - `optional`: whether a plugin tool is optional
- Operators may call `tools.effective` (`operator.read`) to fetch the runtime-effective tool
  inventory for a session.
  - `sessionKey` is required.
  - The gateway derives trusted runtime context from the session server-side instead of accepting
    caller-supplied auth or delivery context.
  - The response is session-scoped and reflects what the active conversation can use right now,
    including core, plugin, and channel tools.
- Operators may call `skills.status` (`operator.read`) to fetch the visible
  skill inventory for an agent.
  - `agentId` is optional; omit it to read the default agent workspace.
  - The response includes eligibility, missing requirements, config checks, and
    sanitized install options without exposing raw secret values.
- Operators may call `skills.search` and `skills.detail` (`operator.read`) for
  ClawHub discovery metadata.
- Operators may call `skills.install` (`operator.admin`) in two modes:
  - ClawHub mode: `{ source: "clawhub", slug, version?, force? }` installs a
    skill folder into the default agent workspace `skills/` directory.
  - Gateway installer mode: `{ name, installId, dangerouslyForceUnsafeInstall?, timeoutMs? }`
    runs a declared `metadata.openclaw.install` action on the gateway host.
- Operators may call `skills.update` (`operator.admin`) in two modes:
  - ClawHub mode updates one tracked slug or all tracked ClawHub installs in
    the default agent workspace.
  - Config mode patches `skills.entries.<skillKey>` values such as `enabled`,
    `apiKey`, and `env`.

## Exec approvals

- When an exec request needs approval, the gateway broadcasts `exec.approval.requested`.
- Operator clients resolve by calling `exec.approval.resolve` (requires `operator.approvals` scope).
- For `host=node`, `exec.approval.request` must include `systemRunPlan` (canonical `argv`/`cwd`/`rawCommand`/session metadata). Requests missing `systemRunPlan` are rejected.
- After approval, forwarded `node.invoke system.run` calls reuse that canonical
  `systemRunPlan` as the authoritative command/cwd/session context.
- If a caller mutates `command`, `rawCommand`, `cwd`, `agentId`, or
  `sessionKey` between prepare and the final approved `system.run` forward, the
  gateway rejects the run instead of trusting the mutated payload.

## Agent delivery fallback

- `agent` requests can include `deliver=true` to request outbound delivery.
- `bestEffortDeliver=false` keeps strict behavior: unresolved or internal-only delivery targets return `INVALID_REQUEST`.
- `bestEffortDeliver=true` allows fallback to session-only execution when no external deliverable route can be resolved (for example internal/webchat sessions or ambiguous multi-channel configs).

## Versioning

- `PROTOCOL_VERSION` lives in `src/gateway/protocol/schema.ts`.
- Clients send `minProtocol` + `maxProtocol`; the server rejects mismatches.
- Schemas + models are generated from TypeBox definitions:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Auth

- If `OPENCLAW_GATEWAY_TOKEN` (or `--token`) is set, `connect.params.auth.token`
  must match or the socket is closed.
- After pairing, the Gateway issues a **device token** scoped to the connection
  role + scopes. It is returned in `hello-ok.auth.deviceToken` and should be
  persisted by the client for future connects.
- Clients should persist the primary `hello-ok.auth.deviceToken` after any
  successful connect.
- Additional `hello-ok.auth.deviceTokens` entries are bootstrap handoff tokens.
  Persist them only when the connect used bootstrap auth on a trusted transport
  such as `wss://` or loopback/local pairing.
- Device tokens can be rotated/revoked via `device.token.rotate` and
  `device.token.revoke` (requires `operator.pairing` scope).
- Token issuance/rotation stays bounded to the approved role set recorded in
  that device's pairing entry; rotating a token cannot expand the device into a
  role that pairing approval never granted.
- Auth failures include `error.details.code` plus recovery hints:
  - `error.details.canRetryWithDeviceToken` (boolean)
  - `error.details.recommendedNextStep` (`retry_with_device_token`, `update_auth_configuration`, `update_auth_credentials`, `wait_then_retry`, `review_auth_configuration`)
- Client behavior for `AUTH_TOKEN_MISMATCH`:
  - Trusted clients may attempt one bounded retry with a cached per-device token.
  - If that retry fails, clients should stop automatic reconnect loops and surface operator action guidance.

## Device identity + pairing

- Nodes should include a stable device identity (`device.id`) derived from a
  keypair fingerprint.
- Gateways issue tokens per device + role.
- Pairing approvals are required for new device IDs unless local auto-approval
  is enabled.
- **Local** connects include loopback and the gateway host’s own tailnet address
  (so same‑host tailnet binds can still auto‑approve).
- All WS clients must include `device` identity during `connect` (operator + node).
  Control UI can omit it only in these modes:
  - `gateway.controlUi.allowInsecureAuth=true` for localhost-only insecure HTTP compatibility.
  - `gateway.controlUi.dangerouslyDisableDeviceAuth=true` (break-glass, severe security downgrade).
- All connections must sign the server-provided `connect.challenge` nonce.

### Device auth migration diagnostics

For legacy clients that still use pre-challenge signing behavior, `connect` now returns
`DEVICE_AUTH_*` detail codes under `error.details.code` with a stable `error.details.reason`.

Common migration failures:

| Message                     | details.code                     | details.reason           | Meaning                                            |
| --------------------------- | -------------------------------- | ------------------------ | -------------------------------------------------- |
| `device nonce required`     | `DEVICE_AUTH_NONCE_REQUIRED`     | `device-nonce-missing`   | Client omitted `device.nonce` (or sent blank).     |
| `device nonce mismatch`     | `DEVICE_AUTH_NONCE_MISMATCH`     | `device-nonce-mismatch`  | Client signed with a stale/wrong nonce.            |
| `device signature invalid`  | `DEVICE_AUTH_SIGNATURE_INVALID`  | `device-signature`       | Signature payload does not match v2 payload.       |
| `device signature expired`  | `DEVICE_AUTH_SIGNATURE_EXPIRED`  | `device-signature-stale` | Signed timestamp is outside allowed skew.          |
| `device identity mismatch`  | `DEVICE_AUTH_DEVICE_ID_MISMATCH` | `device-id-mismatch`     | `device.id` does not match public key fingerprint. |
| `device public key invalid` | `DEVICE_AUTH_PUBLIC_KEY_INVALID` | `device-public-key`      | Public key format/canonicalization failed.         |

Migration target:

- Always wait for `connect.challenge`.
- Sign the v2 payload that includes the server nonce.
- Send the same nonce in `connect.params.device.nonce`.
- Preferred signature payload is `v3`, which binds `platform` and `deviceFamily`
  in addition to device/client/role/scopes/token/nonce fields.
- Legacy `v2` signatures remain accepted for compatibility, but paired-device
  metadata pinning still controls command policy on reconnect.

## TLS + pinning

- TLS is supported for WS connections.
- Clients may optionally pin the gateway cert fingerprint (see `gateway.tls`
  config plus `gateway.remote.tlsFingerprint` or CLI `--tls-fingerprint`).

## Scope

This protocol exposes the **full gateway API** (status, channels, models, chat,
agent, sessions, nodes, approvals, etc.). The exact surface is defined by the
TypeBox schemas in `src/gateway/protocol/schema.ts`.
