---
summary: "OpenClaw macOS‑Companion‑App (Menüleiste + Gateway‑Broker)"
read_when:
  - Implementierung von macOS‑App‑Funktionen
  - Änderung des Gateway‑Lebenszyklus oder der Node‑Bridging‑Logik unter macOS
title: "macOS‑App"
---

# OpenClaw macOS Companion (Menüleiste + Gateway‑Broker)

Die macOS‑App ist der **Menüleisten‑Companion** für OpenClaw. Sie verwaltet Berechtigungen,
verwaltet/verbindet sich lokal mit dem Gateway (launchd oder manuell) und stellt dem Agenten macOS‑Funktionen als Node bereit.

## Was sie tut

- Zeigt native Benachrichtigungen und Status in der Menüleiste an.
- Verwaltet TCC‑Abfragen (Benachrichtigungen, Bedienungshilfen, Bildschirmaufnahme, Mikrofon,
  Spracherkennung, Automation/AppleScript).
- Startet oder verbindet sich mit dem Gateway (lokal oder remote).
- Stellt macOS‑spezifische Werkzeuge bereit (Canvas, Kamera, Bildschirmaufnahme, `system.run`).
- Startet den lokalen Node‑Host‑Dienst im **Remote**‑Modus (launchd) und stoppt ihn im **Local**‑Modus.
- Hostet optional **PeekabooBridge** für UI‑Automatisierung.
- Installiert auf Wunsch die globale CLI (`openclaw`) über npm/pnpm (bun wird für die Gateway‑Laufzeit nicht empfohlen).

## Local‑ vs. Remote‑Modus

- **Local** (Standard): Die App verbindet sich mit einem laufenden lokalen Gateway, falls vorhanden;
  andernfalls aktiviert sie den launchd‑Dienst über `openclaw gateway install`.
- **Remote**: Die App verbindet sich über SSH/Tailscale mit einem Gateway und startet niemals
  einen lokalen Prozess.
  Die App startet den lokalen **Node‑Host‑Dienst**, damit das entfernte Gateway diesen Mac erreichen kann.
  Die App startet das Gateway nicht als Child‑Prozess.

## Launchd‑Steuerung

Die App verwaltet einen benutzerspezifischen LaunchAgent mit dem Label `bot.molt.gateway`
(oder `bot.molt.<profile>` bei Verwendung von `--profile`/`OPENCLAW_PROFILE`; das Legacy‑Label `com.openclaw.*` wird weiterhin entladen).

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Ersetzen Sie das Label durch `bot.molt.<profile>`, wenn Sie ein benanntes Profil ausführen.

Wenn der LaunchAgent nicht installiert ist, aktivieren Sie ihn über die App oder führen Sie
`openclaw gateway install` aus.

## Node‑Fähigkeiten (mac)

Die macOS‑App präsentiert sich als Node. Häufige Befehle:

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Kamera: `camera.snap`, `camera.clip`
- Bildschirm: `screen.record`
- System: `system.run`, `system.notify`

Der Node meldet eine `permissions`‑Map, damit Agenten entscheiden können, was erlaubt ist.

Node‑Dienst + App‑IPC:

- Wenn der headless Node‑Host‑Dienst läuft (Remote‑Modus), verbindet er sich als Node mit dem Gateway‑WebSocket.
- `system.run` wird in der macOS‑App (UI/TCC‑Kontext) über einen lokalen Unix‑Socket ausgeführt; Abfragen und Ausgaben verbleiben in der App.

Diagramm (SCI):

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## Exec‑Genehmigungen (system.run)

`system.run` wird über **Exec‑Genehmigungen** in der macOS‑App gesteuert (Einstellungen → Exec‑Genehmigungen).
Sicherheit + Nachfrage + Allowlist werden lokal auf dem Mac gespeichert unter:

```
~/.openclaw/exec-approvals.json
```

Beispiel:

```json
{
  "version": 1,
  "defaults": {
    "security": "deny",
    "ask": "on-miss"
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [{ "pattern": "/opt/homebrew/bin/rg" }]
    }
  }
}
```

Hinweise:

- `allowlist`‑Einträge sind Glob‑Patterns für aufgelöste Binärpfade.
- Die Auswahl „Immer erlauben“ im Prompt fügt diesen Befehl zur Allowlist hinzu.
- `system.run`‑Umgebungsüberschreibungen werden gefiltert (entfernt `PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT`) und anschließend mit der Umgebung der App zusammengeführt.

## Deep Links

Die App registriert das URL‑Schema `openclaw://` für lokale Aktionen.

### `openclaw://agent`

Löst eine Gateway‑`agent`‑Anfrage aus.

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

Query‑Parameter:

- `message` (erforderlich)
- `sessionKey` (optional)
- `thinking` (optional)
- `deliver` / `to` / `channel` (optional)
- `timeoutSeconds` (optional)
- `key` (optional, Schlüssel für unbeaufsichtigten Modus)

Sicherheit:

- Ohne `key` fordert die App eine Bestätigung an.
- Mit einem gültigen `key` läuft der Vorgang unbeaufsichtigt (gedacht für persönliche Automatisierungen).

## Onboarding‑Ablauf (typisch)

1. Installieren und starten Sie **OpenClaw.app**.
2. Schließen Sie die Berechtigungs‑Checkliste ab (TCC‑Abfragen).
3. Stellen Sie sicher, dass der **Local**‑Modus aktiv ist und das Gateway läuft.
4. Installieren Sie die CLI, wenn Sie Terminalzugriff wünschen.

## Build‑ & Dev‑Workflow (nativ)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (oder Xcode)
- App paketieren: `scripts/package-mac-app.sh`

## Gateway‑Konnektivität debuggen (macOS‑CLI)

Verwenden Sie die Debug‑CLI, um denselben Gateway‑WebSocket‑Handshake und dieselbe Discovery‑Logik auszuführen,
die die macOS‑App verwendet – ohne die App zu starten.

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

Verbindungsoptionen:

- `--url <ws://host:port>`: Konfiguration überschreiben
- `--mode <local|remote>`: aus Konfiguration auflösen (Standard: config oder local)
- `--probe`: eine frische Health‑Probe erzwingen
- `--timeout <ms>`: Request‑Timeout (Standard: `15000`)
- `--json`: strukturierte Ausgabe zum Vergleichen

Discovery‑Optionen:

- `--include-local`: Gateways einschließen, die als „local“ herausgefiltert würden
- `--timeout <ms>`: gesamtes Discovery‑Zeitfenster (Standard: `2000`)
- `--json`: strukturierte Ausgabe zum Vergleichen

Tipp: Vergleichen Sie mit `openclaw gateway discover --json`, um zu sehen, ob sich die Discovery‑Pipeline der macOS‑App
(NWBrowser + tailnet‑DNS‑SD‑Fallback) von der `dns-sd`‑basierten Discovery der Node‑CLI unterscheidet.

## Remote‑Verbindungs‑Plumbing (SSH‑Tunnel)

Wenn die macOS‑App im **Remote**‑Modus läuft, öffnet sie einen SSH‑Tunnel, damit lokale UI‑Komponenten
mit einem entfernten Gateway kommunizieren können, als befände es sich auf localhost.

### Control‑Tunnel (Gateway‑WebSocket‑Port)

- **Zweck:** Health‑Checks, Status, Web‑Chat, Konfiguration und weitere Control‑Plane‑Aufrufe.
- **Lokaler Port:** der Gateway‑Port (Standard `18789`), immer stabil.
- **Remote‑Port:** derselbe Gateway‑Port auf dem entfernten Host.
- **Verhalten:** kein zufälliger lokaler Port; die App verwendet einen bestehenden gesunden Tunnel erneut
  oder startet ihn bei Bedarf neu.
- **SSH‑Form:** `ssh -N -L <local>:127.0.0.1:<remote>` mit BatchMode +
  ExitOnForwardFailure + Keepalive‑Optionen.
- **IP‑Reporting:** Der SSH‑Tunnel verwendet Loopback, daher sieht das Gateway die Node‑IP als
  `127.0.0.1`. Verwenden Sie den Transport **Direct (ws/wss)**, wenn die echte Client‑IP erscheinen soll
  (siehe [macOS‑Remotezugriff](/platforms/mac/remote)).

Für Einrichtungsschritte siehe [macOS‑Remotezugriff](/platforms/mac/remote). Für Protokolldetails siehe [Gateway‑Protokoll](/gateway/protocol).

## Verwandte Dokumente

- [Gateway‑Runbook](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [macOS‑Berechtigungen](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
