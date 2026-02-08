---
summary: "WebSocket connect/auth/pairing fields (connect.auth vs connect.device) with examples"
read_when:
  - Implementing a gateway WS client (Control UI, ZiggyStarClaw, node-mode)
  - Debugging pairing / device auth signatures / device tokens
title: "Gateway WS connect/auth fields"
---

# Gateway WS connect/auth fields

This doc defines the **exact** fields used by the gateway WebSocket protocol during `connect`, including:

- `connect.auth` (gateway access control: token/password)
- `connect.device` (device-bound signatures for pairing + scope upgrades)
- the **device token** returned in `hello-ok.auth.deviceToken`

Source of truth:

- Schema: `src/gateway/protocol/schema/frames.ts` (`ConnectParamsSchema`, `HelloOkSchema`)
- Server handler: `src/gateway/server/ws-connection/message-handler.ts`
- Device auth payload builder: `src/gateway/device-auth.ts`
- Tests/examples: `src/gateway/server.auth.e2e.test.ts`

## 1) The `connect` frame

Client → Gateway:

```jsonc
{
  "type": "connect",
  "params": {
    "minProtocol": 1,
    "maxProtocol": 1,

    "client": {
      "id": "control-ui",
      "version": "1.0.0",
      "platform": "web",
      "mode": "webchat",

      // optional metadata
      "displayName": "Deano’s laptop",
      "deviceFamily": "Mac",
      "modelIdentifier": "MacBookPro18,3",
      "instanceId": "...",
    },

    // optional
    "role": "operator",
    "scopes": ["operator.read"],

    // optional
    "caps": ["canvas"],
    "commands": ["nodes.run"],
    "permissions": { "tools.exec": true },

    // optional
    "pathEnv": "/usr/local/bin:/usr/bin:...",

    // auth mechanisms (see below)
    "auth": { "token": "…" },
    "device": { "id": "…", "publicKey": "…", "signature": "…", "signedAt": 0, "nonce": "…" },

    // optional
    "locale": "en-US",
    "userAgent": "...",
  },
}
```

Notes:

- `minProtocol`/`maxProtocol` are negotiated against the gateway’s `PROTOCOL_VERSION`.
- `client.id` is a known identifier (see `src/gateway/protocol/client-info.ts`).
- `role`/`scopes` are **requested** by the client; the gateway may downgrade or reject depending on pairing state.

## 2) `connect.auth`: gateway access control (token/password)

`connect.auth` is about **access to the gateway at all**.

Schema (exact fields):

```ts
auth?: {
  token?: string
  password?: string
}
```

Typical patterns:

- **Remote gateway token** (common):
  - client sends `auth.token`
  - gateway compares to configured token (or env)
- **Password mode** (alternative):
  - client sends `auth.password`

If the gateway is configured to require a token/password and the client omits it, the connection is rejected.

## 3) `connect.device`: device-bound signatures (pairing + scope upgrades)

`connect.device` enables _device-bound auth_ so the gateway can safely:

- create/track a stable **device identity** (`device.id`)
- require explicit **pairing** before granting or upgrading scopes
- issue a **device token** (see `hello-ok.auth.deviceToken`)

Schema (exact fields):

```ts
device?: {
  id: string
  publicKey: string
  signature: string
  signedAt: number
  nonce?: string
}
```

### 3.1 Device ID derivation

In practice, `device.id` should be derived from `device.publicKey` (see `deriveDeviceIdFromPublicKey` in `src/infra/device-identity.ts`).

### 3.2 Signature payload: `buildDeviceAuthPayload`

The gateway verifies `device.signature` over a **string payload** built like:

- builder: `src/gateway/device-auth.ts` (`buildDeviceAuthPayload`)
- delimiter: `|`

Fields (in order):

- `version` (defaults to `v1`, or `v2` when `nonce` is present)
- `deviceId`
- `clientId`
- `clientMode`
- `role`
- `scopes` (comma-separated)
- `signedAtMs`
- `token` (the gateway auth token string; empty string if absent)
- `nonce` (v2 only)

This means:

- the signature is bound to the requested `role`+`scopes`
- and (when used) bound to the **gateway auth token** value

### 3.3 Clock skew

The gateway applies a skew window when validating `signedAt` (see `DEVICE_SIGNATURE_SKEW_MS` in `message-handler.ts`).

## 4) Pairing + device tokens

When a device is not yet paired (or is requesting a scope upgrade), the gateway may:

- create a pending pairing request
- require an operator approval (`openclaw pairing approve …` / UI approval)

Once paired, the gateway can issue a **device token** and return it in the `hello-ok` frame:

```jsonc
{
  "type": "hello-ok",
  "protocol": 1,
  "server": { "version": "…", "connId": "…" },
  "features": { "methods": [], "events": [] },
  "snapshot": {
    /* … */
  },
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read"],
    "issuedAtMs": 1730000000000,
  },
  "policy": { "maxPayload": 1048576, "maxBufferedBytes": 10485760, "tickIntervalMs": 15000 },
}
```

### Device token reuse

For a paired device, subsequent connects can use:

- `connect.auth.token = <deviceToken>`

See test: `accepts device token auth for paired device` in `src/gateway/server.auth.e2e.test.ts`.

### Revocation

Device tokens can be revoked/rotated. A revoked device token is rejected on connect.

## 5) Practical recipes

### Recipe A: token-only connect (no device identity)

Use this for simple tools or when you don’t need pairing/scopes:

```jsonc
{
  "type": "connect",
  "params": {
    "minProtocol": 1,
    "maxProtocol": 1,
    "client": { "id": "control-ui", "version": "1.0.0", "platform": "web", "mode": "webchat" },
    "auth": { "token": "GATEWAY_TOKEN" },
  },
}
```

### Recipe B: device-signed connect (pairing/scopes)

Use this when requesting operator scopes (or upgrading them):

1. Build the device payload string with `buildDeviceAuthPayload`.
2. Sign it with the device private key.
3. Send `connect.device` alongside `connect.auth`.

(See `server.auth.e2e.test.ts` for a working end-to-end example.)

---

If you’re updating ZiggyStarClaw’s client implementation, mirror this doc there and link back to the exact source files listed at the top.
