---
summary: "Gateway WebSocket protocol: handshake, frames, versioning"
read_when:
  - Pagpapatupad o pag-update ng mga gateway WS client
  - Pag-debug ng mga protocol mismatch o pagkabigo sa pagkonekta
  - Muling pagbuo ng mga schema/model ng protocol
title: "Gateway Protocol"
x-i18n:
  source_path: gateway/protocol.md
  source_hash: bdafac40d5356590
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:39Z
---

# Gateway protocol (WebSocket)

Ang Gateway WS protocol ang **nag-iisang control plane + node transport** para sa
OpenClaw. Lahat ng client (CLI, web UI, macOS app, iOS/Android nodes, headless
nodes) ay kumokonekta sa WebSocket at nagdedeklara ng kanilang **role** +
**scope** sa oras ng handshake.

## Transport

- WebSocket, mga text frame na may JSON payload.
- Ang unang frame **dapat** ay isang `connect` request.

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

Kapag naglabas ng device token, ang `hello-ok` ay kasama rin ang:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### Halimbawa ng node

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

Ang mga method na may side-effect ay nangangailangan ng **idempotency keys** (tingnan ang schema).

## Roles + scopes

### Roles

- `operator` = control plane client (CLI/UI/automation).
- `node` = capability host (camera/screen/canvas/system.run).

### Scopes (operator)

Mga karaniwang scope:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Caps/commands/permissions (node)

Ang mga node ay nagdedeklara ng mga capability claim sa oras ng connect:

- `caps`: mga high-level na kategorya ng capability.
- `commands`: command allowlist para sa invoke.
- `permissions`: mga granular toggle (hal. `screen.record`, `camera.capture`).

Itinuturing ng Gateway ang mga ito bilang **claims** at ipinapatupad ang mga server-side allowlist.

## Presence

- Ang `system-presence` ay nagbabalik ng mga entry na naka-key ayon sa device identity.
- Kasama sa mga presence entry ang `deviceId`, `roles`, at `scopes` upang makapagpakita ang mga UI ng iisang row bawat device
  kahit kumokonekta ito bilang parehong **operator** at **node**.

### Mga helper method ng node

- Maaaring tawagin ng mga node ang `skills.bins` upang kunin ang kasalukuyang listahan ng mga skill executable
  para sa mga auto-allow check.

## Exec approvals

- Kapag ang isang exec request ay nangangailangan ng approval, ibinobroadcast ng gateway ang `exec.approval.requested`.
- Nireresolba ng mga operator client sa pamamagitan ng pagtawag sa `exec.approval.resolve` (nangangailangan ng `operator.approvals` scope).

## Versioning

- Ang `PROTOCOL_VERSION` ay nasa `src/gateway/protocol/schema.ts`.
- Ang mga client ay nagpapadala ng `minProtocol` + `maxProtocol`; tinatanggihan ng server ang mga mismatch.
- Ang mga schema + model ay bina-buo mula sa mga TypeBox definition:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Auth

- Kung ang `OPENCLAW_GATEWAY_TOKEN` (o `--token`) ay naka-set, ang `connect.params.auth.token`
  ay dapat tumugma o isasara ang socket.
- Pagkatapos ng pairing, ang Gateway ay naglalabas ng **device token** na naka-scope sa connection
  role + scopes. Ibinabalik ito sa `hello-ok.auth.deviceToken` at dapat
  i-persist ng client para sa mga susunod na connect.
- Ang mga device token ay maaaring i-rotate/i-revoke sa pamamagitan ng `device.token.rotate` at
  `device.token.revoke` (nangangailangan ng `operator.pairing` scope).

## Device identity + pairing

- Dapat magsama ang mga node ng isang stable na device identity (`device.id`) na nagmula sa
  fingerprint ng keypair.
- Naglalabas ang mga Gateway ng mga token kada device + role.
- Kinakailangan ang mga pairing approval para sa mga bagong device ID maliban kung naka-enable ang local auto-approval.
- Ang mga **Local** na connect ay kinabibilangan ng loopback at ng sariling tailnet address ng host ng gateway
  (kaya ang same-host tailnet bind ay maaari pa ring ma-auto-approve).
- Lahat ng WS client ay dapat magsama ng `device` identity sa panahon ng `connect` (operator + node).
  Maaaring laktawan ito ng Control UI **lamang** kapag naka-enable ang `gateway.controlUi.allowInsecureAuth`
  (o `gateway.controlUi.dangerouslyDisableDeviceAuth` para sa break-glass na paggamit).
- Ang mga non-local na koneksyon ay dapat pumirma sa server-provided na `connect.challenge` nonce.

## TLS + pinning

- Sinusuportahan ang TLS para sa mga WS connection.
- Maaaring opsyonal na i-pin ng mga client ang gateway cert fingerprint (tingnan ang `gateway.tls`
  config kasama ang `gateway.remote.tlsFingerprint` o CLI `--tls-fingerprint`).

## Scope

Inilalantad ng protocol na ito ang **buong gateway API** (status, channels, models, chat,
agent, sessions, nodes, approvals, atbp.). Ang eksaktong surface ay tinutukoy ng mga
TypeBox schema sa `src/gateway/protocol/schema.ts`.
