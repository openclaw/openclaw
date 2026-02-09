---
summary: "Gateway WebSocket-protokol: håndtryk, frames, versionering"
read_when:
  - Implementering eller opdatering af gateway WS-klienter
  - Fejlfinding af protokol-mismatch eller forbindelsesfejl
  - Gengenerering af protokolschemaer/modeller
title: "Gateway-protokol"
---

# Gateway-protokol (WebSocket)

Gateway WS-protokollen er **single control plane + node transport** for
OpenClaw. Alle klienter (CLI, web UI, macOS app, iOS/Android noder, headless
nodes) connect over WebSocket og erklærer deres **rolle** + **scope** på
handshake time.

## Transport

- WebSocket, tekst-frames med JSON-payloads.
- Første frame **skal** være en `connect`-anmodning.

## Håndtryk (forbindelse)

Gateway → Klient (forudgående challenge):

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

Når der udstedes et device token, inkluderer `hello-ok` også:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### Node-eksempel

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

- **Anmodning**: `{type:"req", id, method, params}`
- **Svar**: `{type:"res", id, ok, payload|error}`
- **Hændelse**: `{type:"event", event, payload, seq?, stateVersion?}`

Metoder med sideeffekter kræver **idempotency-nøgler** (se schema).

## Roller + scopes

### Roller

- `operator` = kontrolplan-klient (CLI/UI/automatisering).
- `node` = capability-vært (kamera/skærm/canvas/system.run).

### Scopes (operatør)

Almindelige scopes:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Caps/kommandoer/tilladelser (node)

Noder erklærer capability-claims ved forbindelsen:

- `caps`: overordnede capability-kategorier.
- `commands`: kommando-tilladelsesliste for invoke.
- `tilladelser`: omslag i granulatform (f.eks. `screen.record`, `camera.capture`).

Gatewayen behandler disse som **claims** og håndhæver server-side tilladelseslister.

## Tilstedeværelse

- `system-presence` returnerer poster med nøgler baseret på enhedsidentitet.
- Tilstedeværelsesposter inkluderer `deviceId`, `roles` og `scopes`, så UI’er kan vise én række pr. enhed
  selv når den forbinder som både **operatør** og **node**.

### Hjælpemetoder for noder

- Noder kan kalde `skills.bins` for at hente den aktuelle liste over skill-eksekverbare filer
  til auto-allow-tjek.

## Exec-godkendelser

- Når en exec-anmodning kræver godkendelse, udsender gatewayen `exec.approval.requested`.
- Operatørklienter løser dette ved at kalde `exec.approval.resolve` (kræver `operator.approvals`-scope).

## Versionering

- `PROTOCOL_VERSION` findes i `src/gateway/protocol/schema.ts`.
- Klienter sender `minProtocol` + `maxProtocol`; serveren afviser mismatch.
- Schemaer + modeller genereres fra TypeBox-definitioner:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Autentificering

- Hvis `OPENCLAW_GATEWAY_TOKEN` (eller `--token`) er sat, skal `connect.params.auth.token`
  matche, ellers lukkes socketten.
- Efter parring udsteder Gateway en **enheds token** scoped to the connection
  role + scopes. Det returneres i `hello-ok.auth.deviceToken` og bør være
  fortsatte af klienten for fremtidige forbindelser.
- Device tokens kan roteres/tilbagekaldes via `device.token.rotate` og
  `device.token.revoke` (kræver `operator.pairing`-scope).

## Enhedsidentitet + parring

- Noder bør inkludere en stabil enhedsidentitet (`device.id`) afledt af et
  nøglepars fingeraftryk.
- Gateways udsteder tokens pr. enhed + rolle.
- Parringsgodkendelser kræves for nye enheds-ID’er, medmindre lokal auto-godkendelse
  er aktiveret.
- **Lokale** forbindelser inkluderer loopback og gateway-værtens egen tailnet-adresse
  (så same-host tailnet-binds stadig kan auto-godkendes).
- Alle WS-klienter skal indeholde 'enhed' identitet under 'connect' (operatør + indholdselement).
  Control UI kan udelade det **kun**, når `gateway.controlUi.allowInsecureAuth` er aktiveret
  (eller `gateway.controlUi.dangerouslyDisableDeviceAuth` til brug i glas brug).
- Ikke-lokale forbindelser skal signere den serverleverede `connect.challenge`-nonce.

## TLS + pinning

- TLS understøttes for WS-forbindelser.
- Klienter kan valgfrit pinne gateway-certifikatets fingeraftryk (se `gateway.tls`-
  konfiguration samt `gateway.remote.tlsFingerprint` eller CLI `--tls-fingerprint`).

## Scope

Denne protokol udsætter **fuld gateway API** (status, kanaler, modeller, chat,
agent, sessioner, knudepunkter, godkendelser osv.). Den nøjagtige overflade defineres ved
TypeBox skemaerne i 'src/gateway/protocol/schema.ts'.
