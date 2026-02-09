---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — Gateways ausführen, abfragen und entdecken"
read_when:
  - Ausführen des Gateway über die CLI (Entwicklung oder Server)
  - Debugging von Gateway-Authentifizierung, Bind-Modi und Konnektivität
  - Entdecken von Gateways via Bonjour (LAN + Tailnet)
title: "Gateway"
---

# Gateway CLI

Der Gateway ist der WebSocket-Server von OpenClaw (Kanäle, Nodes, Sitzungen, Hooks).

Unterbefehle auf dieser Seite befinden sich unter `openclaw gateway …`.

Zugehörige Dokumente:

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Gateway ausführen

Einen lokalen Gateway-Prozess starten:

```bash
openclaw gateway
```

Alias im Vordergrund:

```bash
openclaw gateway run
```

Hinweise:

- Standardmäßig verweigert der Gateway den Start, sofern `gateway.mode=local` nicht in `~/.openclaw/openclaw.json` gesetzt ist. Verwenden Sie `--allow-unconfigured` für ad-hoc-/Entwicklungsläufe.
- Binden über den loopback hinaus ohne Authentifizierung ist blockiert (Sicherheitsleitplanke).
- `SIGUSR1` löst bei Autorisierung einen In-Process-Neustart aus (aktivieren Sie `commands.restart` oder verwenden Sie das Gateway-Werkzeug/Config apply/update).
- `SIGINT`/`SIGTERM`-Handler stoppen den Gateway-Prozess, stellen jedoch keinen benutzerdefinierten Terminalzustand wieder her. Wenn Sie die CLI mit einer TUI oder Raw-Mode-Eingabe umhüllen, stellen Sie das Terminal vor dem Beenden wieder her.

### Optionen

- `--port <port>`: WebSocket-Port (Standard kommt aus Konfiguration/Umgebungsvariablen; üblicherweise `18789`).
- `--bind <loopback|lan|tailnet|auto|custom>`: Listener-Bind-Modus.
- `--auth <token|password>`: Überschreibung des Authentifizierungsmodus.
- `--token <token>`: Token-Override (setzt auch `OPENCLAW_GATEWAY_TOKEN` für den Prozess).
- `--password <password>`: Passwort-Override (setzt auch `OPENCLAW_GATEWAY_PASSWORD` für den Prozess).
- `--tailscale <off|serve|funnel>`: Gateway über Tailscale exponieren.
- `--tailscale-reset-on-exit`: Tailscale-Serve/Funnel-Konfiguration beim Herunterfahren zurücksetzen.
- `--allow-unconfigured`: Gateway-Start ohne `gateway.mode=local` in der Konfiguration erlauben.
- `--dev`: Dev-Konfiguration + Workspace erstellen, falls fehlend (überspringt BOOTSTRAP.md).
- `--reset`: Dev-Konfiguration + Zugangsdaten + Sitzungen + Workspace zurücksetzen (erfordert `--dev`).
- `--force`: Vor dem Start jeden bestehenden Listener auf dem ausgewählten Port beenden.
- `--verbose`: Ausführliche Logs.
- `--claude-cli-logs`: Nur claude-cli-Logs in der Konsole anzeigen (und dessen stdout/stderr aktivieren).
- `--ws-log <auto|full|compact>`: WebSocket-Logstil (Standard `auto`).
- `--compact`: Alias für `--ws-log compact`.
- `--raw-stream`: Rohe Modell-Stream-Ereignisse nach jsonl protokollieren.
- `--raw-stream-path <path>`: Pfad für raw-stream-jsonl.

## Einen laufenden Gateway abfragen

Alle Abfragebefehle verwenden WebSocket-RPC.

Ausgabemodus:

- Standard: menschenlesbar (in TTY farbig).
- `--json`: maschinenlesbares JSON (ohne Styling/Spinner).
- `--no-color` (oder `NO_COLOR=1`): ANSI deaktivieren bei Beibehaltung des menschlichen Layouts.

Gemeinsame Optionen (wo unterstützt):

- `--url <url>`: Gateway-WebSocket-URL.
- `--token <token>`: Gateway-Token.
- `--password <password>`: Gateway-Passwort.
- `--timeout <ms>`: Timeout/Budget (variiert je Befehl).
- `--expect-final`: Auf eine „finale“ Antwort warten (Agent-Aufrufe).

Hinweis: Wenn Sie `--url` setzen, greift die CLI nicht auf Konfigurations- oder Umgebungs-Zugangsdaten zurück.
Übergeben Sie `--token` oder `--password` explizit. Fehlende explizite Zugangsdaten sind ein Fehler.

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` zeigt den Gateway-Dienst (launchd/systemd/schtasks) sowie eine optionale RPC-Probe.

```bash
openclaw gateway status
openclaw gateway status --json
```

Optionen:

- `--url <url>`: Überschreibt die Probe-URL.
- `--token <token>`: Token-Authentifizierung für die Probe.
- `--password <password>`: Passwort-Authentifizierung für die Probe.
- `--timeout <ms>`: Probe-Timeout (Standard `10000`).
- `--no-probe`: RPC-Probe überspringen (nur Dienstansicht).
- `--deep`: Auch systemweite Dienste scannen.

### `gateway probe`

`gateway probe` ist der „alles debuggen“-Befehl. Er prüft immer:

- Ihren konfigurierten Remote-Gateway (falls gesetzt) und
- localhost (loopback) **selbst wenn ein Remote konfiguriert ist**.

Wenn mehrere Gateways erreichbar sind, werden alle ausgegeben. Mehrere Gateways werden unterstützt, wenn Sie isolierte Profile/Ports verwenden (z. B. ein Rescue-Bot), die meisten Installationen betreiben jedoch weiterhin einen einzelnen Gateway.

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### Remote über SSH (Mac-App-Parität)

Der macOS-App-Modus „Remote over SSH“ verwendet ein lokales Port-Forwarding, sodass der Remote-Gateway (der ggf. nur an loopback gebunden ist) unter `ws://127.0.0.1:<port>` erreichbar wird.

CLI-Äquivalent:

```bash
openclaw gateway probe --ssh user@gateway-host
```

Optionen:

- `--ssh <target>`: `user@host` oder `user@host:port` (Port standardmäßig `22`).
- `--ssh-identity <path>`: Identitätsdatei.
- `--ssh-auto`: Ersten entdeckten Gateway-Host als SSH-Ziel auswählen (nur LAN/WAB).

Konfiguration (optional, als Standardwerte verwendet):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

Low-Level-RPC-Helfer.

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Gateway-Dienst verwalten

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

Hinweise:

- `gateway install` unterstützt `--port`, `--runtime`, `--token`, `--force`, `--json`.
- Lebenszyklusbefehle akzeptieren `--json` für Skripting.

## Gateways entdecken (Bonjour)

`gateway discover` scannt nach Gateway-Beacons (`_openclaw-gw._tcp`).

- Multicast DNS-SD: `local.`
- Unicast DNS-SD (Wide-Area Bonjour): Wählen Sie eine Domain (Beispiel: `openclaw.internal.`) und richten Sie Split-DNS + einen DNS-Server ein; siehe [/gateway/bonjour](/gateway/bonjour)

Nur Gateways mit aktivierter Bonjour-Discovery (Standard) senden das Beacon.

Wide-Area-Discovery-Datensätze enthalten (TXT):

- `role` (Gateway-Rollenhinweis)
- `transport` (Transporthinweis, z. B. `gateway`)
- `gatewayPort` (WebSocket-Port, üblicherweise `18789`)
- `sshPort` (SSH-Port; standardmäßig `22`, falls nicht vorhanden)
- `tailnetDns` (MagicDNS-Hostname, sofern verfügbar)
- `gatewayTls` / `gatewayTlsSha256` (TLS aktiviert + Zertifikat-Fingerprint)
- `cliPath` (optional: Hinweis für Remote-Installationen)

### `gateway discover`

```bash
openclaw gateway discover
```

Optionen:

- `--timeout <ms>`: Timeout pro Befehl (Browse/Resolve); Standard `2000`.
- `--json`: Maschinenlesbare Ausgabe (deaktiviert auch Styling/Spinner).

Beispiele:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
