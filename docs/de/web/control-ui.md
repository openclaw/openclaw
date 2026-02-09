---
summary: "„Browserbasierte Control UI für das Gateway (Chat, Nodes, Konfiguration)“"
read_when:
  - Sie möchten das Gateway über einen Browser bedienen
  - Sie möchten Tailnet-Zugriff ohne SSH-Tunnel
title: "„Control UI“"
---

# Control UI (Browser)

Die Control UI ist eine kleine **Vite + Lit** Single-Page-App, die vom Gateway bereitgestellt wird:

- Standard: `http://<host>:18789/`
- optionaler Präfix: setzen Sie `gateway.controlUi.basePath` (z. B. `/openclaw`)

Sie spricht **direkt mit dem Gateway-WebSocket** auf demselben Port.

## Schnell öffnen (lokal)

Wenn das Gateway auf demselben Computer läuft, öffnen Sie:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (oder [http://localhost:18789/](http://localhost:18789/))

Wenn die Seite nicht lädt, starten Sie zuerst das Gateway: `openclaw gateway`.

Die Authentifizierung wird während des WebSocket-Handshakes bereitgestellt über:

- `connect.params.auth.token`
- `connect.params.auth.password`
  Im Einstellungsbereich des Dashboards können Sie ein Token speichern; Passwörter werden nicht persistiert.
  Der Onboarding-Assistent erzeugt standardmäßig ein Gateway-Token; fügen Sie es daher beim ersten Verbinden hier ein.

## Geräte-Pairing (erste Verbindung)

Wenn Sie die Control UI von einem neuen Browser oder Gerät aus verbinden, verlangt das Gateway
eine **einmalige Pairing-Freigabe** — selbst wenn Sie sich im selben Tailnet
mit `gateway.auth.allowTailscale: true` befinden. Dies ist eine Sicherheitsmaßnahme zur Verhinderung
unbefugten Zugriffs.

**Was Sie sehen:** „disconnected (1008): pairing required“

**So genehmigen Sie das Gerät:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

Nach der Genehmigung wird das Gerät gespeichert und benötigt keine erneute Freigabe, es sei denn,
Sie widerrufen sie mit `openclaw devices revoke --device <id> --role <role>`. Siehe
[Devices CLI](/cli/devices) für Token-Rotation und -Widerruf.

**Hinweise:**

- Lokale Verbindungen (`127.0.0.1`) werden automatisch genehmigt.
- Remote-Verbindungen (LAN, Tailnet usw.) erfordern eine explizite Genehmigung.
- Jedes Browserprofil erzeugt eine eindeutige Geräte-ID; ein Browserwechsel oder
  das Löschen von Browserdaten erfordert daher ein erneutes Pairing.

## Was sie (heute) kann

- Chat mit dem Modell über Gateway WS (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- Streaming von Werkzeugaufrufen + Live-Werkzeugausgabekarten im Chat (Agent-Ereignisse)
- Kanäle: WhatsApp/Telegram/Discord/Slack + Plugin-Kanäle (Mattermost usw.) Status + QR-Login + kanalweise Konfiguration (`channels.status`, `web.login.*`, `config.patch`)
- Instanzen: Präsenzliste + Aktualisieren (`system-presence`)
- Sitzungen: Liste + sitzungsspezifische Thinking-/Verbose-Overrides (`sessions.list`, `sessions.patch`)
- Cron-Jobs: auflisten/hinzufügen/ausführen/aktivieren/deaktivieren + Ausführungsverlauf (`cron.*`)
- Skills: Status, aktivieren/deaktivieren, installieren, API-Schlüssel-Updates (`skills.*`)
- Nodes: Liste + Caps (`node.list`)
- Exec-Freigaben: Gateway- oder Node-Allowlists bearbeiten + Richtlinie für `exec host=gateway/node` abfragen (`exec.approvals.*`)
- Konfiguration: `~/.openclaw/openclaw.json` anzeigen/bearbeiten (`config.get`, `config.set`)
- Konfiguration: Anwenden + Neustart mit Validierung (`config.apply`) und die zuletzt aktive Sitzung aufwecken
- Konfigurationsschreibvorgänge enthalten eine Base-Hash-Schutzmaßnahme, um das Überschreiben paralleler Änderungen zu verhindern
- Konfigurationsschema + Formular-Rendering (`config.schema`, einschließlich Plugin- und Kanal-Schemata); ein Raw-JSON-Editor bleibt verfügbar
- Debug: Status-/Health-/Model-Snapshots + Ereignisprotokoll + manuelle RPC-Aufrufe (`status`, `health`, `models.list`)
- Logs: Live-Tail der Gateway-Dateilogs mit Filter/Export (`logs.tail`)
- Update: Paket-/Git-Update ausführen + Neustart (`update.run`) mit Neustartbericht

Hinweise zum Cron-Jobs-Panel:

- Für isolierte Jobs ist die Auslieferung standardmäßig auf „announce summary“ gesetzt. Sie können auf „none“ wechseln, wenn Sie ausschließlich interne Ausführungen möchten.
- Die Felder Kanal/Ziel erscheinen, wenn „announce“ ausgewählt ist.

## Chat-Verhalten

- `chat.send` ist **nicht blockierend**: Es bestätigt sofort mit `{ runId, status: "started" }`, und die Antwort streamt über `chat`-Ereignisse.
- Erneutes Senden mit derselben `idempotencyKey` gibt während der Ausführung `{ status: "in_flight" }` zurück und nach Abschluss `{ status: "ok" }`.
- `chat.inject` hängt eine Assistenz-Notiz an das Sitzungsprotokoll an und sendet ein `chat`-Ereignis für reine UI-Updates (kein Agent-Lauf, keine Kanalzustellung).
- Stopp:
  - Klicken Sie auf **Stop** (ruft `chat.abort` auf)
  - Tippen Sie `/stop` (oder `stop|esc|abort|wait|exit|interrupt`), um out-of-band abzubrechen
  - `chat.abort` unterstützt `{ sessionKey }` (kein `runId`), um alle aktiven Läufe für diese Sitzung abzubrechen

## Tailnet-Zugriff (empfohlen)

### Integriertes Tailscale Serve (bevorzugt)

Belassen Sie das Gateway auf loopback und lassen Sie es von Tailscale Serve per HTTPS proxyen:

```bash
openclaw gateway --tailscale serve
```

Öffnen Sie:

- `https://<magicdns>/` (oder Ihr konfiguriertes `gateway.controlUi.basePath`)

Standardmäßig können Serve-Anfragen über Tailscale-Identitäts-Header
(`tailscale-user-login`) authentifizieren, wenn `gateway.auth.allowTailscale` auf `true` gesetzt ist. OpenClaw
verifiziert die Identität, indem es die `x-forwarded-for`-Adresse mit
`tailscale whois` auflöst und mit dem Header abgleicht, und akzeptiert diese nur,
wenn die Anfrage loopback mit Tailscales `x-forwarded-*`-Headern erreicht. Setzen Sie
`gateway.auth.allowTailscale: false` (oder erzwingen Sie `gateway.auth.mode: "password"`),
wenn Sie auch für Serve-Traffic ein Token/Passwort verlangen möchten.

### An Tailnet binden + Token

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

Öffnen Sie dann:

- `http://<tailscale-ip>:18789/` (oder Ihr konfiguriertes `gateway.controlUi.basePath`)

Fügen Sie das Token in die UI-Einstellungen ein (gesendet als `connect.params.auth.token`).

## Unsicheres HTTP

Wenn Sie das Dashboard über reines HTTP öffnen (`http://<lan-ip>` oder `http://<tailscale-ip>`),
läuft der Browser in einem **nicht sicheren Kontext** und blockiert WebCrypto. Standardmäßig
**blockiert** OpenClaw Control-UI-Verbindungen ohne Geräteidentität.

**Empfohlene Abhilfe:** Verwenden Sie HTTPS (Tailscale Serve) oder öffnen Sie die UI lokal:

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (auf dem Gateway-Host)

**Downgrade-Beispiel (nur Token über HTTP):**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

Dies deaktiviert Geräteidentität + Pairing für die Control UI (auch über HTTPS). Verwenden Sie dies
nur, wenn Sie dem Netzwerk vertrauen.

Siehe [Tailscale](/gateway/tailscale) für Hinweise zur HTTPS-Einrichtung.

## UI bauen

Das Gateway stellt statische Dateien aus `dist/control-ui` bereit. Bauen Sie sie mit:

```bash
pnpm ui:build # auto-installs UI deps on first run
```

Optionaler absoluter Base-Pfad (wenn Sie feste Asset-URLs wünschen):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

Für lokale Entwicklung (separater Dev-Server):

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

Richten Sie die UI dann auf Ihre Gateway-WS-URL aus (z. B. `ws://127.0.0.1:18789`).

## Debugging/Testing: Dev-Server + Remote-Gateway

Die Control UI besteht aus statischen Dateien; das WebSocket-Ziel ist konfigurierbar und kann sich
vom HTTP-Origin unterscheiden. Das ist praktisch, wenn Sie den Vite-Dev-Server lokal nutzen,
das Gateway jedoch anderswo läuft.

1. Starten Sie den UI-Dev-Server: `pnpm ui:dev`
2. Öffnen Sie eine URL wie:

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

Optionale einmalige Authentifizierung (falls erforderlich):

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

Hinweise:

- `gatewayUrl` wird nach dem Laden in localStorage gespeichert und aus der URL entfernt.
- `token` wird in localStorage gespeichert; `password` wird nur im Speicher gehalten.
- Wenn `gatewayUrl` gesetzt ist, greift die UI nicht auf Konfigurations- oder Umgebungs-Anmeldedaten zurück.
  Geben Sie `token` (oder `password`) explizit an. Fehlende explizite Anmeldedaten sind ein Fehler.
- Verwenden Sie `wss://`, wenn sich das Gateway hinter TLS befindet (Tailscale Serve, HTTPS-Proxy usw.).
- `gatewayUrl` wird nur in einem Top-Level-Fenster akzeptiert (nicht eingebettet), um Clickjacking zu verhindern.
- Für Cross-Origin-Dev-Setups (z. B. `pnpm ui:dev` zu einem Remote-Gateway) fügen Sie den UI-Origin zu
  `gateway.controlUi.allowedOrigins` hinzu.

Beispiel:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

Details zur Remote-Zugriffseinrichtung: [Remote access](/gateway/remote).
