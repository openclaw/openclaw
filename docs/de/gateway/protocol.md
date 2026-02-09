---
summary: "Gateway-WebSocket-Protokoll: Handshake, Frames, Versionierung"
read_when:
  - Implementierung oder Aktualisierung von Gateway-WS-Clients
  - Debugging von Protokollinkompatibilitäten oder Verbindungsfehlern
  - Neuerstellung von Protokollschemas/-modellen
title: "Gateway-Protokoll"
---

# Gateway-Protokoll (WebSocket)

Das Gateway-WS-Protokoll ist die **einzige Kontroll­ebene + Node-Transport** für
OpenClaw. Alle Clients (CLI, Web-UI, macOS-App, iOS/Android-Nodes, headless
Nodes) verbinden sich über WebSocket und deklarieren ihre **Rolle** +
**Geltungsbereiche (Scopes)** zum Zeitpunkt des Handshakes.

## Transport

- WebSocket, Text-Frames mit JSON-Payloads.
- Das erste Frame **muss** eine `connect`-Anfrage sein.

## Handshake (Verbindung)

Gateway → Client (Vorab‑Challenge vor der Verbindung):

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

Wenn ein Gerätetoken ausgegeben wird, enthält `hello-ok` außerdem:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### Knoten-Beispiel

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

- **Anfrage**: `{type:"req", id, method, params}`
- **Antwort**: `{type:"res", id, ok, payload|error}`
- **Ereignis**: `{type:"event", event, payload, seq?, stateVersion?}`

Methoden mit Nebenwirkungen erfordern **Idempotenzschlüssel** (siehe Schema).

## Rollen + Scopes

### Rollen

- `operator` = Kontroll­ebenen‑Client (CLI/UI/Automatisierung).
- `node` = Fähigkeits‑Host (Kamera/Bildschirm/Canvas/system.run).

### Scopes (Operator)

Häufige Scopes:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Caps/Commands/Berechtigungen (Node)

Nodes deklarieren beim Verbinden Fähigkeitsansprüche:

- `caps`: übergeordnete Fähigkeitskategorien.
- `commands`: Befehls‑Allowlist für Aufrufe.
- `permissions`: granulare Schalter (z. B. `screen.record`, `camera.capture`).

Das Gateway behandelt diese als **Claims** und erzwingt serverseitige Allowlists.

## Presence

- `system-presence` liefert Einträge, die nach Geräteidentität geschlüsselt sind.
- Presence‑Einträge enthalten `deviceId`, `roles` und `scopes`, sodass UIs eine einzelne Zeile pro Gerät anzeigen können,
  selbst wenn es sich sowohl als **Operator** als auch als **Node** verbindet.

### Node‑Hilfsmethoden

- Nodes können `skills.bins` aufrufen, um die aktuelle Liste der Skill‑Executables
  für Auto‑Allow‑Prüfungen abzurufen.

## Exec-Genehmigungen

- Wenn eine Exec‑Anfrage eine Freigabe benötigt, sendet das Gateway `exec.approval.requested` als Broadcast.
- Operator‑Clients lösen dies durch Aufruf von `exec.approval.resolve` (erfordert den Scope `operator.approvals`).

## Versionierung

- `PROTOCOL_VERSION` befindet sich in `src/gateway/protocol/schema.ts`.
- Clients senden `minProtocol` + `maxProtocol`; der Server lehnt Abweichungen ab.
- Schemas + Modelle werden aus TypeBox‑Definitionen generiert:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Auth

- Wenn `OPENCLAW_GATEWAY_TOKEN` (oder `--token`) gesetzt ist, muss `connect.params.auth.token`
  übereinstimmen, andernfalls wird der Socket geschlossen.
- Nach der Paarung stellt das Gateway einen **Geräte-Token** dar, der auf die Verbindung
  Rolle + Skala reicht. Es wird in `hello-ok.auth.deviceToken` zurückgegeben und sollte vom Client
  für zukünftige Verbindungen persistiert werden.
- Gerätetoken können über `device.token.rotate` und
  `device.token.revoke` rotiert/widerrufen werden (erfordert den Scope `operator.pairing`).

## Geräteidentität + Pairing

- Nodes sollten eine stabile Geräteidentität (`device.id`) angeben, die aus einem
  Schlüsselpaar‑Fingerprint abgeleitet ist.
- Gateways geben Tokens pro Gerät + Rolle aus.
- Pairing‑Freigaben sind für neue Geräte‑IDs erforderlich, sofern lokale Auto‑Freigabe
  nicht aktiviert ist.
- **Lokale** Verbindungen umfassen Loopback und die eigene Tailnet‑Adresse des Gateway‑Hosts
  (sodass Tailnet‑Bindings auf demselben Host weiterhin auto‑freigegeben werden können).
- Alle WS‑Clients müssen während `connect` (Operator + Node) eine `device`‑Identität angeben.
  Die Kontroll‑UI darf sie **nur** weglassen, wenn `gateway.controlUi.allowInsecureAuth` aktiviert ist
  (oder `gateway.controlUi.dangerouslyDisableDeviceAuth` für Break‑Glass‑Nutzung).
- Nicht‑lokale Verbindungen müssen den vom Server bereitgestellten `connect.challenge`‑Nonce signieren.

## TLS + Pinning

- TLS wird für WS‑Verbindungen unterstützt.
- Clients können optional den Zertifikats‑Fingerprint des Gateways pinnen (siehe die
  `gateway.tls`‑Konfiguration sowie `gateway.remote.tlsFingerprint` oder CLI `--tls-fingerprint`).

## Geltungsbereich

Dieses Protokoll stellt die **vollständige Gateway‑API** bereit (Status, Kanäle, Modelle, Chat,
Agent, Sitzungen, Nodes, Freigaben usw.). Der exakte Umfang wird durch die TypeBox‑Schemas in
`src/gateway/protocol/schema.ts` definiert.
