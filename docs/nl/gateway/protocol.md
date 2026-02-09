---
summary: "Gateway WebSocket-protocol: handshake, frames, versiebeheer"
read_when:
  - Implementeren of bijwerken van Gateway WS-clients
  - Debuggen van protocol-mismatches of verbindingsfouten
  - Opnieuw genereren van protocolschema’s/modellen
title: "Gateway-protocol"
---

# Gateway-protocol (WebSocket)

Het Gateway WS-protocol is het **enige control plane + node-transport** voor
OpenClaw. Alle clients (CLI, web-UI, macOS-app, iOS/Android-nodes, headless
nodes) verbinden via WebSocket en verklaren hun **rol** + **scope** tijdens de
handshake.

## Transport

- WebSocket, tekstframes met JSON-payloads.
- Het eerste frame **moet** een `connect`-request zijn.

## Handshake (verbinden)

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

Wanneer een apparaattoken wordt uitgegeven, bevat `hello-ok` ook:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### Node-voorbeeld

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

Methoden met bijwerkingen vereisen **idempotency keys** (zie schema).

## Rollen + scopes

### Rollen

- `operator` = control plane-client (CLI/UI/automatisering).
- `node` = capability-host (camera/scherm/canvas/system.run).

### Scopes (operator)

Veelvoorkomende scopes:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Caps/commands/permissions (node)

Nodes verklaren capability-claims tijdens het verbinden:

- `caps`: hoog-niveau capability-categorieën.
- `commands`: command-allowlist voor invoke.
- `permissions`: fijnmazige toggles (bijv. `screen.record`, `camera.capture`).

De Gateway behandelt deze als **claims** en handhaaft server-side allowlists.

## Presence

- `system-presence` retourneert items die zijn gesleuteld op apparaatidentiteit.
- Presence-items bevatten `deviceId`, `roles` en `scopes`, zodat UI’s één rij per apparaat kunnen tonen,
  zelfs wanneer het zowel als **operator** als **node** verbindt.

### Node-hulpmethoden

- Nodes kunnen `skills.bins` aanroepen om de huidige lijst met skill-executables
  op te halen voor auto-allow-controles.

## Exec approvals

- Wanneer een exec-aanvraag goedkeuring vereist, broadcast de gateway `exec.approval.requested`.
- Operator-clients lossen dit op door `exec.approval.resolve` aan te roepen (vereist `operator.approvals`-scope).

## Versionering

- `PROTOCOL_VERSION` leeft in `src/gateway/protocol/schema.ts`.
- Clients sturen `minProtocol` + `maxProtocol`; de server weigert mismatches.
- Schema’s + modellen worden gegenereerd uit TypeBox-definities:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Auth

- Als `OPENCLAW_GATEWAY_TOKEN` (of `--token`) is ingesteld, moet `connect.params.auth.token`
  overeenkomen, anders wordt de socket gesloten.
- Na pairing geeft de Gateway een **apparaattoken** uit, gescopeerd op de
  verbindingsrol + scopes. Deze wordt teruggegeven in `hello-ok.auth.deviceToken` en moet
  door de client worden opgeslagen voor toekomstige verbindingen.
- Apparaattokens kunnen worden geroteerd/ingetrokken via `device.token.rotate` en
  `device.token.revoke` (vereist `operator.pairing`-scope).

## Apparaatidentiteit + pairing

- Nodes moeten een stabiele apparaatidentiteit (`device.id`) opnemen die is afgeleid van een
  keypair-fingerprint.
- Gateways geven tokens uit per apparaat + rol.
- Pairing-goedkeuringen zijn vereist voor nieuwe apparaat-ID’s, tenzij lokale auto-goedkeuring
  is ingeschakeld.
- **Lokale** verbindingen omvatten loopback en het eigen tailnet-adres van de Gateway-host
  (zodat tailnet-binds op dezelfde host nog steeds automatisch kunnen worden goedgekeurd).
- Alle WS-clients moeten `device`-identiteit opnemen tijdens `connect` (operator + node).
  Control UI mag dit **alleen** weglaten wanneer `gateway.controlUi.allowInsecureAuth` is ingeschakeld
  (of `gateway.controlUi.dangerouslyDisableDeviceAuth` voor break-glass-gebruik).
- Niet-lokale verbindingen moeten de door de server geleverde `connect.challenge`-nonce ondertekenen.

## TLS + pinning

- TLS wordt ondersteund voor WS-verbindingen.
- Clients kunnen optioneel de gateway-certificaatvingerafdruk pinnen (zie `gateway.tls`-
  config plus `gateway.remote.tlsFingerprint` of CLI `--tls-fingerprint`).

## Scope

Dit protocol stelt de **volledige gateway-API** bloot (status, kanalen, modellen, chat,
agent, sessies, nodes, goedkeuringen, enz.). Het exacte oppervlak wordt gedefinieerd door de
TypeBox-schema’s in `src/gateway/protocol/schema.ts`.
