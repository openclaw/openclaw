---
summary: "„Runbook für den Gateway‑Dienst, Lebenszyklus und Betrieb“"
read_when:
  - Beim Ausführen oder Debuggen des Gateway‑Prozesses
title: "„Gateway‑Runbook“"
---

# Gateway‑Dienst‑Runbook

Zuletzt aktualisiert: 2025-12-09

## Was es ist

- Der dauerhaft laufende Prozess, der die einzelne Baileys/Telegram‑Verbindung sowie die Kontroll‑/Event‑Ebene besitzt.
- Ersetzt den Legacy‑Befehl `gateway`. CLI‑Einstiegspunkt: `openclaw gateway`.
- Läuft bis zum Stoppen; beendet sich bei fatalen Fehlern mit einem Nicht‑Null‑Exitcode, sodass der Supervisor ihn neu startet.

## So läuft (lokal)

```bash
openclaw gateway --port 18789
# for full debug/trace logs in stdio:
openclaw gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
openclaw gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```

- Konfigurations‑Hot‑Reload überwacht `~/.openclaw/openclaw.json` (oder `OPENCLAW_CONFIG_PATH`).
  - Standardmodus: `gateway.reload.mode="hybrid"` (sichere Änderungen hot anwenden, Neustart bei kritischen Änderungen).
  - Hot‑Reload nutzt bei Bedarf einen In‑Process‑Neustart via **SIGUSR1**.
  - Deaktivieren mit `gateway.reload.mode="off"`.
- Bindet die WebSocket‑Kontrollebene an `127.0.0.1:<port>` (Standard 18789).
- Derselbe Port bedient auch HTTP (Control UI, Hooks, A2UI). Single‑Port‑Multiplex.
  - OpenAI Chat Completions (HTTP): [`/v1/chat/completions`](/gateway/openai-http-api).
  - OpenResponses (HTTP): [`/v1/responses`](/gateway/openresponses-http-api).
  - Tools Invoke (HTTP): [`/tools/invoke`](/gateway/tools-invoke-http-api).
- Startet standardmäßig einen Canvas‑Dateiserver auf `canvasHost.port` (Standard `18793`), der `http://<gateway-host>:18793/__openclaw__/canvas/` aus `~/.openclaw/workspace/canvas` ausliefert. Deaktivieren mit `canvasHost.enabled=false` oder `OPENCLAW_SKIP_CANVAS_HOST=1`.
- Protokolliert nach stdout; verwenden Sie launchd/systemd, um ihn am Laufen zu halten und Logs zu rotieren.
- Übergeben Sie `--verbose`, um Debug‑Logs (Handshakes, Req/Res, Events) bei der Fehlerbehebung aus der Logdatei nach stdio zu spiegeln.
- `--force` verwendet `lsof`, um Listener auf dem gewählten Port zu finden, sendet SIGTERM, protokolliert, was beendet wurde, und startet dann das Gateway (scheitert schnell, wenn `lsof` fehlt).
- Wenn Sie unter einem Supervisor laufen (launchd/systemd/mac‑App‑Child‑Process‑Modus), sendet ein Stopp/Neustart typischerweise **SIGTERM**; ältere Builds können dies als `pnpm` `ELIFECYCLE` Exitcode **143** (SIGTERM) anzeigen, was ein normaler Shutdown ist, kein Crash.
- **SIGUSR1** löst einen In‑Process‑Neustart aus, wenn autorisiert (Gateway‑Tool/Konfig‑Apply/Update oder aktivieren Sie `commands.restart` für manuelle Neustarts).
- Gateway‑Authentifizierung ist standardmäßig erforderlich: setzen Sie `gateway.auth.token` (oder `OPENCLAW_GATEWAY_TOKEN`) oder `gateway.auth.password`. Clients müssen `connect.params.auth.token/password` senden, sofern nicht die Tailscale‑Serve‑Identität verwendet wird.
- Der Assistent erzeugt nun standardmäßig ein Token, selbst auf Loopback.
- Port‑Priorität: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > Standard `18789`.

## Remote‑Zugriff

- Tailscale/VPN bevorzugt; andernfalls SSH‑Tunnel:

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- Clients verbinden sich anschließend über den Tunnel mit `ws://127.0.0.1:18789`.

- Wenn ein Token konfiguriert ist, müssen Clients es auch über den Tunnel in `connect.params.auth.token` mitsenden.

## Mehrere Gateways (gleicher Host)

In der Regel unnötig: Ein Gateway kann mehrere Messaging‑Kanäle und Agents bedienen. Verwenden Sie mehrere Gateways nur für Redundanz oder strikte Isolation (z. B. Rescue‑Bot).

Unterstützt, wenn Sie Zustand + Konfiguration isolieren und eindeutige Ports verwenden. Vollständige Anleitung: [Multiple gateways](/gateway/multiple-gateways).

Servicenamen sind profilbewusst:

- macOS: `bot.molt.<profile>` (Legacy `com.openclaw.*` kann noch existieren)
- Linux: `openclaw-gateway-<profile>.service`
- Windows: `OpenClaw Gateway (<profile>)`

Installationsmetadaten sind in der Service‑Konfiguration eingebettet:

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

Rescue‑Bot‑Muster: Halten Sie ein zweites Gateway isoliert mit eigenem Profil, State‑Verzeichnis, Workspace und Basis‑Port‑Abständen. Vollständige Anleitung: [Rescue‑Bot‑Leitfaden](/gateway/multiple-gateways#rescue-bot-guide).

### Dev‑Profil (`--dev`)

Schneller Weg: Starten Sie eine vollständig isolierte Dev‑Instanz (Konfig/State/Workspace), ohne Ihr primäres Setup zu berühren.

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# then target the dev instance:
openclaw --dev status
openclaw --dev health
```

Standardwerte (können über Env/Flags/Konfig überschrieben werden):

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001` (Gateway WS + HTTP)
- Browser‑Control‑Service‑Port = `19003` (abgeleitet: `gateway.port+2`, nur Loopback)
- `canvasHost.port=19005` (abgeleitet: `gateway.port+4`)
- `agents.defaults.workspace` wird standardmäßig zu `~/.openclaw/workspace-dev`, wenn Sie `setup`/`onboard` unter `--dev` ausführen.

Abgeleitete Ports (Faustregeln):

- Basisport = `gateway.port` (oder `OPENCLAW_GATEWAY_PORT` / `--port`)
- Browser‑Control‑Service‑Port = Basis + 2 (nur Loopback)
- `canvasHost.port = base + 4` (oder `OPENCLAW_CANVAS_HOST_PORT` / Konfig‑Override)
- Browser‑Profil‑CDP‑Ports werden automatisch ab `browser.controlPort + 9 .. + 108` zugewiesen (pro Profil persistiert).

Checkliste pro Instanz:

- eindeutiges `gateway.port`
- eindeutiges `OPENCLAW_CONFIG_PATH`
- eindeutiges `OPENCLAW_STATE_DIR`
- eindeutiges `agents.defaults.workspace`
- separate WhatsApp‑Nummern (bei Nutzung von WA)

Service‑Installation pro Profil:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

Beispiel:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## Protokoll (Operator‑Sicht)

- Vollständige Doku: [Gateway‑Protokoll](/gateway/protocol) und [Bridge‑Protokoll (Legacy)](/gateway/bridge-protocol).
- Obligatorischer erster Frame vom Client: `req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`.
- Gateway antwortet mit `res {type:"res", id, ok:true, payload:hello-ok }` (oder `ok:false` mit Fehler und schließt dann).
- Nach dem Handshake:
  - Requests: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Events: `{type:"event", event, payload, seq?, stateVersion?}`
- Strukturierte Presence‑Einträge: `{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }` (für WS‑Clients kommt `instanceId` von `connect.client.instanceId`).
- `agent`‑Antworten sind zweistufig: zuerst `res`‑Ack `{runId,status:"accepted"}`, dann ein finales `res` `{runId,status:"ok"|"error",summary}` nach Abschluss des Laufs; gestreamte Ausgabe trifft als `event:"agent"` ein.

## Methoden (Initialsatz)

- `health` — vollständiger Health‑Snapshot (gleiche Form wie `openclaw health --json`).
- `status` — Kurzfassung.
- `system-presence` — aktuelle Presence‑Liste.
- `system-event` — Presence/System‑Notiz posten (strukturiert).
- `send` — Nachricht über die aktiven Kanäle senden.
- `agent` — einen Agent‑Turn ausführen (streamt Events über dieselbe Verbindung zurück).
- `node.list` — gepaarte + aktuell verbundene Nodes auflisten (inklusive `caps`, `deviceFamily`, `modelIdentifier`, `paired`, `connected` und beworbene `commands`).
- `node.describe` — einen Node beschreiben (Fähigkeiten + unterstützte `node.invoke`‑Befehle; funktioniert für gepaarte Nodes und aktuell verbundene ungepaarte Nodes).
- `node.invoke` — einen Befehl auf einem Node ausführen (z. B. `canvas.*`, `camera.*`).
- `node.pair.*` — Pairing‑Lebenszyklus (`request`, `list`, `approve`, `reject`, `verify`).

Siehe auch: [Presence](/concepts/presence) dazu, wie Presence erzeugt/dupliziert wird und warum eine stabile `client.instanceId` wichtig ist.

## Events

- `agent` — gestreamte Tool-/Ausgabe‑Events aus dem Agent‑Run (sequenz‑getaggt).
- `presence` — Presence‑Updates (Deltas mit stateVersion), an alle verbundenen Clients gepusht.
- `tick` — periodisches Keepalive/No‑op zur Bestätigung der Erreichbarkeit.
- `shutdown` — Gateway beendet sich; Payload enthält `reason` und optional `restartExpectedMs`. Clients sollten sich neu verbinden.

## WebChat‑Integration

- WebChat ist eine native SwiftUI‑UI, die direkt mit dem Gateway‑WebSocket für Verlauf, Senden, Abbruch und Events kommuniziert.
- Remote‑Nutzung erfolgt über denselben SSH/Tailscale‑Tunnel; wenn ein Gateway‑Token konfiguriert ist, fügt der Client es während `connect` hinzu.
- Die macOS‑App verbindet sich über einen einzelnen WS (geteilte Verbindung); sie hydriert Presence aus dem initialen Snapshot und hört auf `presence`‑Events zur UI‑Aktualisierung.

## Typisierung und Validierung

- Der Server validiert jeden eingehenden Frame mit AJV gegen JSON‑Schema, das aus den Protokolldefinitionen emittiert wird.
- Clients (TS/Swift) konsumieren generierte Typen (TS direkt; Swift über den Generator des Repos).
- Protokolldefinitionen sind die Quelle der Wahrheit; Schema/Modelle neu generieren mit:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## Verbindungs‑Snapshot

- `hello-ok` enthält einen `snapshot` mit `presence`, `health`, `stateVersion` und `uptimeMs` sowie `policy {maxPayload,maxBufferedBytes,tickIntervalMs}`, sodass Clients sofort ohne zusätzliche Requests rendern können.
- `health`/`system-presence` bleiben für manuelles Refresh verfügbar, sind aber beim Verbindungsaufbau nicht erforderlich.

## Fehlercodes (res.error‑Form)

- Fehler verwenden `{ code, message, details?, retryable?, retryAfterMs? }`.
- Standardcodes:
  - `NOT_LINKED` — WhatsApp nicht authentifiziert.
  - `AGENT_TIMEOUT` — Agent hat innerhalb der konfigurierten Frist nicht geantwortet.
  - `INVALID_REQUEST` — Schema-/Parameter‑Validierung fehlgeschlagen.
  - `UNAVAILABLE` — Gateway fährt herunter oder eine Abhängigkeit ist nicht verfügbar.

## Keepalive‑Verhalten

- `tick`‑Events (oder WS‑Ping/Pong) werden periodisch emittiert, damit Clients wissen, dass das Gateway lebt, selbst wenn kein Traffic stattfindet.
- Sende-/Agent‑Acks bleiben separate Antworten; überladen Sie Ticks nicht für Sends.

## Replay / Lücken

- Events werden nicht wiederholt. Clients erkennen Sequenzlücken und sollten vor dem Fortfahren aktualisieren (`health` + `system-presence`). WebChat‑ und macOS‑Clients aktualisieren bei Lücken jetzt automatisch.

## Supervision (macOS‑Beispiel)

- Verwenden Sie launchd, um den Dienst am Laufen zu halten:
  - Program: Pfad zu `openclaw`
  - Arguments: `gateway`
  - KeepAlive: true
  - StandardOut/Err: Dateipfade oder `syslog`
- Bei Fehlern startet launchd neu; fatale Fehlkonfigurationen sollten weiter beenden, damit der Operator es bemerkt.
- LaunchAgents sind benutzerbezogen und erfordern eine angemeldete Sitzung; für Headless‑Setups verwenden Sie einen benutzerdefinierten LaunchDaemon (nicht ausgeliefert).
  - `openclaw gateway install` schreibt `~/Library/LaunchAgents/bot.molt.gateway.plist`
    (oder `bot.molt.<profile>.plist`; Legacy `com.openclaw.*` wird bereinigt).
  - `openclaw doctor` prüft die LaunchAgent‑Konfiguration und kann sie auf aktuelle Standardwerte aktualisieren.

## Gateway‑Dienstverwaltung (CLI)

Verwenden Sie die Gateway‑CLI für Installieren/Starten/Stoppen/Neustarten/Status:

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

Hinweise:

- `gateway status` prüft standardmäßig das Gateway‑RPC über den aufgelösten Port/die Konfiguration des Dienstes (Override mit `--url`).
- `gateway status --deep` fügt System‑Scans hinzu (LaunchDaemons/System‑Units).
- `gateway status --no-probe` überspringt die RPC‑Prüfung (nützlich, wenn das Netzwerk down ist).
- `gateway status --json` ist skriptstabil.
- `gateway status` berichtet **Supervisor‑Runtime** (launchd/systemd läuft) getrennt von **RPC‑Erreichbarkeit** (WS‑Connect + Status‑RPC).
- `gateway status` gibt Konfigpfad + Probe‑Ziel aus, um „localhost vs. LAN‑Bindung“‑Verwirrung und Profil‑Mismatches zu vermeiden.
- `gateway status` enthält die letzte Gateway‑Fehlerzeile, wenn der Dienst laufend wirkt, der Port aber geschlossen ist.
- `logs` folgt dem Gateway‑Dateilog via RPC (kein manuelles `tail`/`grep` nötig).
- Wenn andere gateway‑ähnliche Dienste erkannt werden, warnt die CLI, sofern es sich nicht um OpenClaw‑Profildienste handelt.
  Wir empfehlen weiterhin **ein Gateway pro Maschine** für die meisten Setups; verwenden Sie isolierte Profile/Ports für Redundanz oder einen Rescue‑Bot. Siehe [Multiple gateways](/gateway/multiple-gateways).
  - Bereinigung: `openclaw gateway uninstall` (aktueller Dienst) und `openclaw doctor` (Legacy‑Migrationen).
- `gateway install` ist ein No‑op, wenn bereits installiert; verwenden Sie `openclaw gateway install --force` zur Neuinstallation (Profil/Env/Pfad‑Änderungen).

Gebündelte macOS‑App:

- OpenClaw.app kann ein Node‑basiertes Gateway‑Relay bündeln und einen benutzerbezogenen LaunchAgent mit der Bezeichnung
  `bot.molt.gateway` (oder `bot.molt.<profile>`; Legacy `com.openclaw.*`‑Labels werden weiterhin sauber entladen).
- Zum sauberen Stoppen verwenden Sie `openclaw gateway stop` (oder `launchctl bootout gui/$UID/bot.molt.gateway`).
- Zum Neustart verwenden Sie `openclaw gateway restart` (oder `launchctl kickstart -k gui/$UID/bot.molt.gateway`).
  - `launchctl` funktioniert nur, wenn der LaunchAgent installiert ist; andernfalls zuerst `openclaw gateway install` verwenden.
  - Ersetzen Sie das Label durch `bot.molt.<profile>`, wenn Sie ein benanntes Profil ausführen.

## Supervision (systemd‑Benutzereinheit)

OpenClaw installiert unter Linux/WSL2 standardmäßig einen **systemd‑Benutzerdienst**. Wir
empfehlen Benutzerdienste für Single‑User‑Maschinen (einfachere Umgebung, benutzerspezifische Konfiguration).
Verwenden Sie einen **Systemdienst** für Multi‑User‑ oder Always‑On‑Server (kein Lingering
erforderlich, gemeinsame Supervision).

`openclaw gateway install` schreibt die Benutzereinheit. `openclaw doctor` prüft die
Einheit und kann sie auf die aktuell empfohlenen Standardwerte aktualisieren.

Erstellen Sie `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
Environment=OPENCLAW_GATEWAY_TOKEN=
WorkingDirectory=/home/youruser

[Install]
WantedBy=default.target
```

Aktivieren Sie Lingering (erforderlich, damit der Benutzerdienst Logout/Idle überlebt):

```
sudo loginctl enable-linger youruser
```

Onboarding führt dies unter Linux/WSL2 aus (kann sudo anfordern; schreibt `/var/lib/systemd/linger`).
Aktivieren Sie dann den Dienst:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

**Alternative (Systemdienst)** – für Always‑On‑ oder Multi‑User‑Server können Sie statt einer Benutzereinheit eine systemd‑**System**‑Einheit installieren (kein Lingering nötig).
Erstellen Sie `/etc/systemd/system/openclaw-gateway[-<profile>].service` (kopieren Sie die Einheit oben,
wechseln Sie `WantedBy=multi-user.target`, setzen Sie `User=` + `WorkingDirectory=`), dann:

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## Windows (WSL2)

Windows‑Installationen sollten **WSL2** verwenden und dem obigen Linux‑systemd‑Abschnitt folgen.

## Betriebliche Prüfungen

- Liveness: WS öffnen und `req:connect` senden → erwarten Sie `res` mit `payload.type="hello-ok"` (mit Snapshot).
- Readiness: `health` aufrufen → erwarten Sie `ok: true` und einen verknüpften Kanal in `linkChannel` (falls zutreffend).
- Debug: Abonnieren Sie `tick`‑ und `presence`‑Events; stellen Sie sicher, dass `status` das Link/Auth‑Alter anzeigt; Presence‑Einträge zeigen Gateway‑Host und verbundene Clients.

## Sicherheitsgarantien

- Gehen Sie standardmäßig von einem Gateway pro Host aus; wenn Sie mehrere Profile betreiben, isolieren Sie Ports/State und adressieren Sie die richtige Instanz.
- Kein Fallback auf direkte Baileys‑Verbindungen; ist das Gateway down, schlagen Sends sofort fehl.
- Nicht‑Connect‑Erstframes oder fehlerhaftes JSON werden abgelehnt und der Socket geschlossen.
- Geordneter Shutdown: Emit `shutdown`‑Event vor dem Schließen; Clients müssen Close + Reconnect handhaben.

## CLI‑Hilfen

- `openclaw gateway health|status` — Health/Status über den Gateway‑WS anfordern.
- `openclaw message send --target <num> --message "hi" [--media ...]` — über das Gateway senden (idempotent für WhatsApp).
- `openclaw agent --message "hi" --to <num>` — einen Agent‑Turn ausführen (wartet standardmäßig auf das Finale).
- `openclaw gateway call <method> --params '{"k":"v"}'` — roher Methoden‑Invoker zur Fehlersuche.
- `openclaw gateway stop|restart` — den überwachten Gateway‑Dienst stoppen/neustarten (launchd/systemd).
- Gateway‑Helper‑Unterbefehle gehen von einem laufenden Gateway auf `--url` aus; sie starten keines mehr automatisch.

## Migrationshinweise

- Stellen Sie die Nutzung von `openclaw gateway` und dem Legacy‑TCP‑Control‑Port ein.
- Aktualisieren Sie Clients, sodass sie das WS‑Protokoll mit obligatorischem Connect und strukturierter Presence sprechen.
