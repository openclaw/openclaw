---
summary: "Gateway WebSocket-protokoll: handskakning, ramar, versionering"
read_when:
  - Implementera eller uppdatera gateway-WS-klienter
  - Felsöka protokollmismatchar eller anslutningsfel
  - Återskapa protokollscheman/-modeller
title: "Gateway-protokoll"
x-i18n:
  source_path: gateway/protocol.md
  source_hash: bdafac40d5356590
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:27Z
---

# Gateway-protokoll (WebSocket)

Gateway WS-protokollet är det **enda kontrollplanet + nodtransporten** för
OpenClaw. Alla klienter (CLI, webb-UI, macOS-app, iOS/Android-noder, headless
noder) ansluter via WebSocket och deklarerar sin **roll** + **omfattning** vid
handskakning.

## Transport

- WebSocket, textramar med JSON-payloads.
- Första ramen **måste** vara en `connect`-begäran.

## Handskakning (anslutning)

Gateway → Klient (utmaning före anslutning):

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

Klient → Gateway:

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

Gateway → Klient:

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }
}
```

När en enhetstoken utfärdas inkluderar `hello-ok` även:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### Nodexempel

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

## Inramning

- **Begäran**: `{type:"req", id, method, params}`
- **Svar**: `{type:"res", id, ok, payload|error}`
- **Händelse**: `{type:"event", event, payload, seq?, stateVersion?}`

Metoder med sidoeffekter kräver **idempotensnycklar** (se schema).

## Roller + omfattningar

### Roller

- `operator` = kontrollplansklient (CLI/UI/automation).
- `node` = kapabilitetsvärd (kamera/skärm/canvas/system.run).

### Omfattningar (operatör)

Vanliga omfattningar:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Kapaciteter/kommandon/behörigheter (nod)

Noder deklarerar kapabilitetsanspråk vid anslutning:

- `caps`: övergripande kapabilitetskategorier.
- `commands`: tillåtelselista för kommandon som får anropas.
- `permissions`: detaljerade växlar (t.ex. `screen.record`, `camera.capture`).

Gateway behandlar dessa som **anspråk** och upprätthåller tillåtelselistor på serversidan.

## Närvaro

- `system-presence` returnerar poster nycklade per enhetsidentitet.
- Närvaroposter inkluderar `deviceId`, `roles` och `scopes` så att UI:er kan visa en enda rad per enhet
  även när den ansluter som både **operatör** och **nod**.

### Hjälpmetoder för noder

- Noder kan anropa `skills.bins` för att hämta den aktuella listan över skill-exekverbara filer
  för automatiska tillåtelsekontroller.

## Exec-godkännanden

- När en exec-begäran behöver godkännande sänder gatewayn `exec.approval.requested`.
- Operatörsklienter löser detta genom att anropa `exec.approval.resolve` (kräver omfattningen `operator.approvals`).

## Versionering

- `PROTOCOL_VERSION` finns i `src/gateway/protocol/schema.ts`.
- Klienter skickar `minProtocol` + `maxProtocol`; servern avvisar avvikelser.
- Scheman + modeller genereras från TypeBox-definitioner:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Autentisering

- Om `OPENCLAW_GATEWAY_TOKEN` (eller `--token`) är inställd måste `connect.params.auth.token`
  matcha, annars stängs socketen.
- Efter parning utfärdar Gateway en **enhetstoken** med omfattning enligt anslutningens
  roll + omfattningar. Den returneras i `hello-ok.auth.deviceToken` och bör
  sparas av klienten för framtida anslutningar.
- Enhetstoken kan roteras/återkallas via `device.token.rotate` och
  `device.token.revoke` (kräver omfattningen `operator.pairing`).

## Enhetsidentitet + parning

- Noder bör inkludera en stabil enhetsidentitet (`device.id`) härledd från ett
  nyckelparsfingeravtryck.
- Gateways utfärdar token per enhet + roll.
- Parningstillstånd krävs för nya enhets-ID:n om inte lokal automatisk godkännande
  är aktiverat.
- **Lokala** anslutningar inkluderar loopback och gateway-värdens egen tailnet-adress
  (så att same-host-tailnet-bindningar fortfarande kan auto-godkännas).
- Alla WS-klienter måste inkludera identiteten `device` under `connect` (operatör + nod).
  Kontroll-UI kan utelämna den **endast** när `gateway.controlUi.allowInsecureAuth` är aktiverat
  (eller `gateway.controlUi.dangerouslyDisableDeviceAuth` för break-glass-användning).
- Icke-lokala anslutningar måste signera den serverlevererade `connect.challenge`-noncen.

## TLS + pinning

- TLS stöds för WS-anslutningar.
- Klienter kan valfritt nåla gateway-certifikatets fingeravtryck (se konfigen `gateway.tls`
  samt `gateway.remote.tlsFingerprint` eller CLI `--tls-fingerprint`).

## Omfattning

Detta protokoll exponerar **hela gateway-API:t** (status, kanaler, modeller, chatt,
agent, sessioner, noder, godkännanden m.m.). Den exakta ytan definieras av
TypeBox-scheman i `src/gateway/protocol/schema.ts`.
