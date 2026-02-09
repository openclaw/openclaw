---
summary: "Detailliertes Runbook zur Fehlerbehebung für Gateway, Kanäle, Automatisierung, Nodes und Browser"
read_when:
  - Der Fehlerbehebungs-Hub hat Sie für eine tiefere Diagnose hierher verwiesen
  - Sie benötigen stabile, symptomorientierte Runbook-Abschnitte mit exakten Befehlen
title: "Fehlerbehebung"
---

# Gateway-Fehlerbehebung

Diese Seite ist das ausführliche Runbook.
Beginnen Sie unter [/help/troubleshooting](/help/troubleshooting), wenn Sie zuerst den schnellen Triage-Ablauf möchten.

## Befehlsleiter

Führen Sie diese zuerst aus, in dieser Reihenfolge:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Erwartete gesunde Signale:

- `openclaw gateway status` zeigt `Runtime: running` und `RPC probe: ok`.
- `openclaw doctor` meldet keine blockierenden Konfigurations-/Dienstprobleme.
- `openclaw channels status --probe` zeigt verbundene/bereite Kanäle.

## Keine Antworten

Wenn Kanäle aktiv sind, aber nichts antwortet, prüfen Sie Routing und Richtlinien, bevor Sie irgendetwas neu verbinden.

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

Achten Sie auf:

- Ausstehende Kopplung für DM-Absender.
- Gruppen-Erwähnungs-Gating (`requireMention`, `mentionPatterns`).
- Abweichungen in der Kanal-/Gruppen-Allowlist.

Häufige Signaturen:

- `drop guild message (mention required` → Gruppen-Nachricht wird ignoriert, bis eine Erwähnung erfolgt.
- `pairing request` → Absender benötigt Freigabe.
- `blocked` / `allowlist` → Absender/Kanal wurde durch Richtlinie gefiltert.

Verwandt:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## Dashboard-/Control-UI-Konnektivität

Wenn das Dashboard/die Control-UI keine Verbindung herstellt, validieren Sie URL, Authentifizierungsmodus und Annahmen zum sicheren Kontext.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

Achten Sie auf:

- Korrekte Probe-URL und Dashboard-URL.
- Abweichungen beim Authentifizierungsmodus/Token zwischen Client und Gateway.
- HTTP-Nutzung, wo Geräteidentität erforderlich ist.

Häufige Signaturen:

- `device identity required` → unsicherer Kontext oder fehlende Geräteauthentifizierung.
- `unauthorized` / Reconnect-Schleife → Token-/Passwortabweichung.
- `gateway connect failed:` → falsches Host/Port/URL-Ziel.

Verwandt:

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## Gateway-Dienst läuft nicht

Verwenden Sie dies, wenn der Dienst installiert ist, der Prozess aber nicht stabil läuft.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

Achten Sie auf:

- `Runtime: stopped` mit Exit-Hinweisen.
- Abweichende Dienstkonfiguration (`Config (cli)` vs. `Config (service)`).
- Port-/Listener-Konflikte.

Häufige Signaturen:

- `Gateway start blocked: set gateway.mode=local` → lokaler Gateway-Modus ist nicht aktiviert.
- `refusing to bind gateway ... without auth` → Nicht-Loopback-Bindung ohne Token/Passwort.
- `another gateway instance is already listening` / `EADDRINUSE` → Portkonflikt.

Verwandt:

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## Kanal verbunden, Nachrichten fließen nicht

Wenn der Kanalstatus „verbunden“ ist, der Nachrichtenfluss jedoch ausbleibt, konzentrieren Sie sich auf Richtlinien, Berechtigungen und kanalspezifische Zustellregeln.

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

Achten Sie auf:

- DM-Richtlinie (`pairing`, `allowlist`, `open`, `disabled`).
- Gruppen-Allowlist und Erwähnungsanforderungen.
- Fehlende Kanal-API-Berechtigungen/-Scopes.

Häufige Signaturen:

- `mention required` → Nachricht wird durch Gruppen-Erwähnungsrichtlinie ignoriert.
- `pairing` / Spuren ausstehender Freigaben → Absender ist nicht freigegeben.
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → Kanal-Auth-/Berechtigungsproblem.

Verwandt:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Cron- und Heartbeat-Zustellung

Wenn Cron oder Heartbeat nicht ausgeführt wurde oder nicht zugestellt hat, prüfen Sie zuerst den Scheduler-Status, dann das Zustellziel.

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

Achten Sie auf:

- Cron aktiviert und nächstes Aufwachen vorhanden.
- Status der Job-Ausführungshistorie (`ok`, `skipped`, `error`).
- Gründe für Heartbeat-Überspringen (`quiet-hours`, `requests-in-flight`, `alerts-disabled`).

Häufige Signaturen:

- `cron: scheduler disabled; jobs will not run automatically` → Cron deaktiviert.
- `cron: timer tick failed` → Scheduler-Tick fehlgeschlagen; prüfen Sie Datei-/Log-/Runtime-Fehler.
- `heartbeat skipped` mit `reason=quiet-hours` → außerhalb des Zeitfensters aktiver Stunden.
- `heartbeat: unknown accountId` → ungültige Konto-ID für das Heartbeat-Zustellziel.

Verwandt:

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## Gekoppeltes Node-Werkzeug schlägt fehl

Wenn ein Node gekoppelt ist, Werkzeuge jedoch fehlschlagen, isolieren Sie Vordergrund-, Berechtigungs- und Freigabestatus.

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

Achten Sie auf:

- Node online mit erwarteten Fähigkeiten.
- OS-Berechtigungen für Kamera/Mikrofon/Standort/Bildschirm.
- Exec-Freigaben und Allowlist-Status.

Häufige Signaturen:

- `NODE_BACKGROUND_UNAVAILABLE` → Node-App muss im Vordergrund sein.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → fehlende OS-Berechtigung.
- `SYSTEM_RUN_DENIED: approval required` → Exec-Freigabe ausstehend.
- `SYSTEM_RUN_DENIED: allowlist miss` → Befehl durch Allowlist blockiert.

Verwandt:

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## Browser-Werkzeug schlägt fehl

Verwenden Sie dies, wenn Aktionen des Browser-Werkzeugs fehlschlagen, obwohl das Gateway selbst gesund ist.

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

Achten Sie auf:

- Gültigen Pfad zur Browser-Executable.
- Erreichbarkeit des CDP-Profils.
- Anbindung des Extension-Relay-Tabs für `profile="chrome"`.

Häufige Signaturen:

- `Failed to start Chrome CDP on port` → Browser-Prozess konnte nicht gestartet werden.
- `browser.executablePath not found` → konfigurierter Pfad ist ungültig.
- `Chrome extension relay is running, but no tab is connected` → Extension-Relay nicht angebunden.
- `Browser attachOnly is enabled ... not reachable` → reines Attach-Profil hat kein erreichbares Ziel.

Verwandt:

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## Wenn Sie aktualisiert haben und plötzlich etwas nicht mehr funktioniert

Die meisten Probleme nach einem Upgrade sind Konfigurationsdrift oder nun durchgesetzte strengere Standardwerte.

### 1. Verhalten bei Authentifizierung und URL-Overrides geändert

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

Was zu prüfen ist:

- Wenn `gateway.mode=remote`, können CLI-Aufrufe auf „remote“ zielen, während Ihr lokaler Dienst in Ordnung ist.
- Explizite `--url`-Aufrufe fallen nicht auf gespeicherte Anmeldedaten zurück.

Häufige Signaturen:

- `gateway connect failed:` → falsches URL-Ziel.
- `unauthorized` → Endpunkt erreichbar, aber falsche Authentifizierung.

### 2. Bind- und Auth-Guardrails sind strenger

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

Was zu prüfen ist:

- Nicht-Loopback-Bindungen (`lan`, `tailnet`, `custom`) erfordern konfigurierte Authentifizierung.
- Alte Schlüssel wie `gateway.token` ersetzen nicht `gateway.auth.token`.

Häufige Signaturen:

- `refusing to bind gateway ... without auth` → Bind+Auth-Abweichung.
- `RPC probe: failed` während die Runtime läuft → Gateway lebt, ist aber mit aktueller Auth/URL nicht erreichbar.

### 3. Kopplungs- und Geräteidentitätsstatus geändert

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

Was zu prüfen ist:

- Ausstehende Gerätefreigaben für Dashboard/Nodes.
- Ausstehende DM-Kopplungsfreigaben nach Richtlinien- oder Identitätsänderungen.

Häufige Signaturen:

- `device identity required` → Geräteauthentifizierung nicht erfüllt.
- `pairing required` → Absender/Gerät muss freigegeben werden.

Wenn Dienstkonfiguration und Runtime nach den Prüfungen weiterhin nicht übereinstimmen, installieren Sie die Dienstmetadaten aus demselben Profil-/Statusverzeichnis neu:

```bash
openclaw gateway install --force
openclaw gateway restart
```

Verwandt:

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
