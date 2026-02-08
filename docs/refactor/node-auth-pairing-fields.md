# Node auth + pairing protocol fields (draft)

Goal: **write down the exact wire fields** we expect for node/operator connections and device-bound auth/pairing.

This is intentionally a _draft_ that makes ambiguities explicit, so we can quickly converge on a single, testable schema.

Related background:

- `docs/refactor/clawnet.md#unified-authentication--pairing`

---

## Terminology

- **Gateway**: OpenClaw gateway.
- **Client**: any connecting device (node runtime, operator UI, CLI, etc.).
- **Role**: per-connection role (e.g. `node` vs `operator`).
- **Device identity**: stable identity derived from a device public key (preferred).
- **Pairing**: operator approval that results in credentials issuance.

---

## High-level phases

1. **Unauthenticated connect**

- Client connects to gateway.
- Client presents a minimal `clientHello` (identity + desired role + capabilities).

2. **Authentication**

- If the client already has credentials:
  - prove possession (device key signature) and/or present an issued token.
- Otherwise:
  - gateway creates a pairing request for `deviceId`.

3. **Pairing approval**

- Operator approves/denies.
- Gateway issues credentials bound to device key + role/scope.

4. **Authenticated reconnect (or upgrade)**

- Client connects again with credentials.

---

## Proposed message shapes (actual today)

This section describes what OpenClaw actually speaks today for the Gateway WS handshake.

Implementation references:

- Connect params schema: `src/gateway/protocol/schema/frames.ts` → `ConnectParamsSchema`
- Hello payload schema: `src/gateway/protocol/schema/frames.ts` → `HelloOkSchema`
- Client connect sender: `src/gateway/client.ts` → `sendConnect()`
- Server handshake handler: `src/gateway/server/ws-connection/message-handler.ts` (first `req` must be `connect`)
- Device attestation payload: `src/gateway/device-auth.ts` → `buildDeviceAuthPayload()`
- Signing + key material: `src/infra/device-identity.ts`
- Local device token persistence: `src/infra/device-auth-store.ts` (`device-auth.json`)

### 1) Connection metadata (transport)

Transport is **WebSocket**. The first client message must be a request frame:

```json
{
  "type": "req",
  "id": "h1",
  "method": "connect",
  "params": {
    "minProtocol": 1,
    "maxProtocol": 1,
    "client": {
      "id": "node-host",
      "displayName": "Deano’s Mac mini",
      "version": "dev",
      "platform": "darwin",
      "mode": "node",
      "instanceId": "macmini-01"
    },
    "caps": ["tool-events"],
    "role": "node",
    "scopes": ["node.invoke"],
    "commands": ["screen.record", "camera.snap"],
    "device": {
      "id": "<deviceId>",
      "publicKey": "<base64url-raw-public-key>",
      "signature": "<base64url-signature>",
      "signedAt": 1707231900000,
      "nonce": "<nonce-from-connect.challenge>"
    },
    "auth": {
      "token": "<shared-token-optional>",
      "password": null
    }
  }
}
```

Notes:

- This is the **only** handshake message. There is no separate `connect.hello` / `connect.auth` today.
- `device.*` is a **device-bound attestation** over a payload built by `buildDeviceAuthPayload(...)`.
- `role`, `scopes`, `commands` are client-declared but may be filtered/overridden by server policy.

### 2) `connect.challenge` (gateway → client)

On socket open, the gateway emits an event containing a `nonce`.

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": {
    "nonce": "<string>"
  }
}
```

Notes:

- For some non-local hosts, the gateway **requires** the nonce to be included in `params.device.nonce`.

### 3) `hello-ok` response (gateway → client)

Gateway responds to the `connect` request with a normal response frame whose payload is `hello-ok`:

```json
{
  "type": "res",
  "id": "h1",
  "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": 1,
    "server": {
      "version": "dev",
      "commit": "<optional>",
      "host": "<hostname>",
      "connId": "<connId>"
    },
    "features": {
      "methods": ["..."],
      "events": ["..."]
    },
    "snapshot": { "...": "..." },
    "canvasHostUrl": "<optional>",
    "auth": {
      "deviceToken": "<device-token>",
      "role": "node",
      "scopes": ["node.invoke"],
      "issuedAtMs": 1707231960000
    },
    "policy": {
      "maxPayload": 26214400,
      "maxBufferedBytes": 26214400,
      "tickIntervalMs": 30000
    }
  }
}
```

Notes:

- When device auth is used successfully, the gateway may return `payload.auth.deviceToken`.
- That token is persisted client-side in `device-auth.json` via `src/infra/device-auth-store.ts`.

### 4) Pairing

**TBD (for this doc):** the node/operator _pairing approval_ flow is not currently expressed as `pairing.*` WS frames in the gateway protocol layer.

What exists today:

- **Channel/DM pairing** (human approval codes) lives under `core.channel.pairing.*` and is documented in `docs/start/pairing.md`.
- **Device-bound gateway auth** for WS clients uses the `connect` handshake above + server-issued `deviceToken`.

Open question to resolve for WORK_ITEMS_GLOBAL#9:

- Do we want explicit gateway pairing frames/APIs for nodes/operators (and if so, do we model it as WS events/reqs, REST endpoints, or both)?

---

## Minimal acceptance criteria

- One canonical list of fields for:
  - client identity
  - device-bound auth challenge/response
  - pairing requested/approve/deny/issued
- At least one end-to-end example (node) and one (operator).

---

## Next step

- Confirm the exact field names + where they live today in code.
- Update this doc to remove ambiguity and add references to implementation locations.
