# Auth + pairing protocol (current)

This document captures the **current, implemented** WebSocket auth/pairing fields as used by the gateway.

It focuses on two related pieces:

- `connect` request fields (including `connect.auth` and `connect.device`)
- the **device signature payload** (`device-auth`) that the client must sign

Source of truth (code):

- `src/gateway/protocol/schema/frames.ts` (`ConnectParamsSchema`)
- `src/gateway/device-auth.ts` (`buildDeviceAuthPayload`)
- `src/gateway/server/ws-connection/message-handler.ts` (validation + nonce rules)

## 1) WS handshake: `connect` request

Clients begin by sending a request frame (shape omitted here) with `method: "connect"` and `params` matching `ConnectParamsSchema`.

### `ConnectParams` fields

```ts
{
  minProtocol: number;
  maxProtocol: number;

  client: {
    id: string;           // e.g. "control-ui", "cli", ...
    displayName?: string; // human-friendly
    version: string;      // client build version
    platform: string;     // e.g. "darwin", "win32", "linux", "android"
    deviceFamily?: string;
    modelIdentifier?: string;
    mode: string;         // client mode (see GatewayClientModeSchema)
    instanceId?: string;
  };

  // Optional capability declarations
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;

  // Optional environment info
  pathEnv?: string;
  locale?: string;
  userAgent?: string;

  // AuthZ intent (used for scoping/role decisions)
  role?: string;
  scopes?: string[];

  // Device identity (public-key based)
  device?: {
    id: string;          // deviceId (must match fingerprint(publicKey))
    publicKey: string;   // base64url
    signature: string;   // signature over device-auth payload (see below)
    signedAt: number;    // ms since epoch
    nonce?: string;      // required for non-loopback connections
  };

  // Shared-secret auth (token/password)
  auth?: {
    token?: string;
    password?: string;
  };
}
```

### Example `connect` params (device + token)

```json
{
  "minProtocol": 1,
  "maxProtocol": 1,
  "client": {
    "id": "cli",
    "displayName": "Deano’s laptop",
    "version": "0.0.0-dev",
    "platform": "linux",
    "mode": "operator"
  },
  "role": "operator",
  "scopes": ["operator.*"],
  "auth": { "token": "<gateway-auth-token>" },
  "device": {
    "id": "<deviceId>",
    "publicKey": "<base64url-publicKey>",
    "signedAt": 1760000000000,
    "nonce": "<server-provided-connectNonce>",
    "signature": "<signature-over-device-auth-payload>"
  }
}
```

Notes:

- `device.nonce` is **required** for non-loopback connections.
- `device.signedAt` must be “fresh” (currently ±10 minutes skew allowed).

## 2) Device signature payload (`device-auth`)

The gateway verifies `connect.device.signature` by reconstructing a payload string and verifying it with the provided `device.publicKey`.

Source: `src/gateway/device-auth.ts`.

### Payload format

The payload is a `|`-delimited string:

- **v1** (legacy / loopback-only):

```
v1|<deviceId>|<clientId>|<clientMode>|<role>|<scopesCsv>|<signedAtMs>|<token>
```

- **v2** (nonce-bound):

```
v2|<deviceId>|<clientId>|<clientMode>|<role>|<scopesCsv>|<signedAtMs>|<token>|<nonce>
```

Where:

- `scopesCsv` is `scopes.join(",")` (empty allowed)
- `token` is `connect.auth.token` (or empty string when absent)
- `nonce` is `connect.device.nonce`

### Version selection

`buildDeviceAuthPayload()` selects:

- `v2` if a nonce is present
- otherwise `v1`

The server may accept `v1` signatures **only** in limited “legacy loopback” situations.

## 3) Relationship between `connect.auth` and device-auth

- `connect.auth` proves knowledge of a shared secret (token/password).
- `connect.device` proves possession of a device private key.
- The **device-auth signature payload includes the token** (if present) and the requested `role`/`scopes`, binding those claims to the device key.

In other words: the device signature is not just a device identity check; it also binds the requested access intent (role/scopes) and (optionally) the shared secret token into a single signed statement.

## 4) Server response: `hello-ok` (auth token issuance)

On success the server responds with `hello-ok`. When device identity is used, the gateway may issue a device-bound token:

```json
{
  "type": "hello-ok",
  "protocol": 1,
  "server": { "version": "...", "connId": "..." },
  "features": { "methods": [], "events": [] },
  "snapshot": { "...": "..." },
  "auth": {
    "deviceToken": "<device-token>",
    "role": "operator",
    "scopes": ["operator.*"],
    "issuedAtMs": 1760000000000
  },
  "policy": { "maxPayload": 1048576, "maxBufferedBytes": 16777216, "tickIntervalMs": 10000 }
}
```

`deviceToken` can later be presented as `connect.auth.token`, and the gateway may validate it against the paired device + requested role/scopes.
