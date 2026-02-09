---
summary: "„Cron-Jobs + Wakeups für den Gateway-Scheduler“"
read_when:
  - Planen von Hintergrundjobs oder Wakeups
  - Verdrahten von Automatisierungen, die mit oder neben Heartbeats laufen sollen
  - Entscheidung zwischen Heartbeat und Cron für geplante Aufgaben
title: "„Cron Jobs“"
---

# Cron-Jobs (Gateway-Scheduler)

> **Cron vs. Heartbeat?** Siehe [Cron vs Heartbeat](/automation/cron-vs-heartbeat) für Hinweise, wann welches Verfahren zu verwenden ist.

Cron ist der integrierte Scheduler des Gateways. Er persistiert Jobs, weckt den Agenten
zum richtigen Zeitpunkt und kann optional Ausgaben zurück in einen Chat liefern.

Wenn Sie _„jeden Morgen ausführen“_ oder _„den Agenten in 20 Minuten anstoßen“_ möchten,
ist Cron der passende Mechanismus.

Fehlerbehebung: [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Cron läuft **innerhalb des Gateways** (nicht innerhalb des Modells).
- Jobs werden unter `~/.openclaw/cron/` persistiert, sodass Neustarts keine Zeitpläne verlieren.
- Zwei Ausführungsarten:
  - **Hauptsitzung**: Einreihen eines Systemereignisses, dann Ausführung beim nächsten Heartbeat.
  - **Isoliert**: Ausführung eines dedizierten Agent-Turns in `cron:<jobId>`, mit Zustellung (standardmäßig Ankündigung oder keine).
- Wakeups sind erstklassig: Ein Job kann „jetzt wecken“ statt „nächster Heartbeat“ anfordern.

## Schnellstart (praxisnah)

Erstellen Sie eine einmalige Erinnerung, prüfen Sie, dass sie existiert, und führen Sie sie sofort aus:

```bash
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the cron docs draft" \
  --wake now \
  --delete-after-run

openclaw cron list
openclaw cron run <job-id>
openclaw cron runs --id <job-id>
```

Planen Sie einen wiederkehrenden isolierten Job mit Zustellung:

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

## Tool-Call-Entsprechungen (Gateway-Cron-Tool)

Für die kanonischen JSON-Formate und Beispiele siehe [JSON schema for tool calls](/automation/cron-jobs#json-schema-for-tool-calls).

## Wo Cron-Jobs gespeichert werden

Cron-Jobs werden standardmäßig auf dem Gateway-Host unter `~/.openclaw/cron/jobs.json` persistiert.
Das Gateway lädt die Datei in den Speicher und schreibt sie bei Änderungen zurück, daher sind manuelle Bearbeitungen
nur sicher, wenn das Gateway gestoppt ist. Bevorzugen Sie `openclaw cron add/edit` oder die Cron-Tool-Call-API für Änderungen.

## Einsteigerfreundlicher Überblick

Stellen Sie sich einen Cron-Job so vor: **wann** ausführen + **was** tun.

1. **Zeitplan wählen**
   - Einmalige Erinnerung → `schedule.kind = "at"` (CLI: `--at`)
   - Wiederkehrender Job → `schedule.kind = "every"` oder `schedule.kind = "cron"`
   - Wenn Ihr ISO-Zeitstempel keine Zeitzone enthält, wird er als **UTC** behandelt.

2. **Ausführungsort wählen**
   - `sessionTarget: "main"` → Ausführung beim nächsten Heartbeat mit Hauptkontext.
   - `sessionTarget: "isolated"` → Ausführung eines dedizierten Agent-Turns in `cron:<jobId>`.

3. **Payload wählen**
   - Hauptsitzung → `payload.kind = "systemEvent"`
   - Isolierte Sitzung → `payload.kind = "agentTurn"`

Optional: Einmalige Jobs (`schedule.kind = "at"`) werden standardmäßig nach Erfolg gelöscht. Setzen Sie
`deleteAfterRun: false`, um sie zu behalten (sie werden nach Erfolg deaktiviert).

## Konzepte

### Jobs

Ein Cron-Job ist ein gespeicherter Datensatz mit:

- einem **Zeitplan** (wann er laufen soll),
- einer **Payload** (was er tun soll),
- optionalem **Zustellmodus** (Ankündigung oder keiner).
- optionaler **Agent-Bindung** (`agentId`): Ausführung des Jobs unter einem bestimmten Agenten; wenn
  fehlend oder unbekannt, fällt das Gateway auf den Standard-Agenten zurück.

Jobs werden durch eine stabile `jobId` identifiziert (verwendet von CLI/Gateway-APIs).
In Agent-Tool-Calls ist `jobId` kanonisch; das Legacy-Feld `id` wird aus Kompatibilitätsgründen akzeptiert.
Einmalige Jobs werden standardmäßig nach Erfolg automatisch gelöscht; setzen Sie `deleteAfterRun: false`, um sie zu behalten.

### Zeitpläne

Cron unterstützt drei Arten von Zeitplänen:

- `at`: einmaliger Zeitstempel via `schedule.at` (ISO 8601).
- `every`: festes Intervall (ms).
- `cron`: 5-Feld-Cron-Ausdruck mit optionaler IANA-Zeitzone.

Cron-Ausdrücke verwenden `croner`. Wenn keine Zeitzone angegeben ist, wird die lokale
Zeitzone des Gateway-Hosts verwendet.

### Haupt- vs. isolierte Ausführung

#### Jobs der Hauptsitzung (Systemereignisse)

Hauptjobs reihen ein Systemereignis ein und können optional den Heartbeat-Runner wecken.
Sie müssen `payload.kind = "systemEvent"` verwenden.

- `wakeMode: "now"` (Standard): Ereignis löst einen sofortigen Heartbeat-Lauf aus.
- `wakeMode: "next-heartbeat"`: Ereignis wartet auf den nächsten geplanten Heartbeat.

Dies passt am besten, wenn Sie den normalen Heartbeat-Prompt + Kontext der Hauptsitzung möchten.
Siehe [Heartbeat](/gateway/heartbeat).

#### Isolierte Jobs (dedizierte Cron-Sitzungen)

Isolierte Jobs führen einen dedizierten Agent-Turn in der Sitzung `cron:<jobId>` aus.

Zentrale Verhaltensweisen:

- Der Prompt wird zur Nachverfolgbarkeit mit `[cron:<jobId> <job name>]` vorangestellt.
- Jeder Lauf startet eine **frische Sitzungs-ID** (keine Übernahme vorheriger Konversationen).
- Standardverhalten: Wenn `delivery` fehlt, kündigen isolierte Jobs eine Zusammenfassung an (`delivery.mode = "announce"`).
- `delivery.mode` (nur isoliert) legt fest, was passiert:
  - `announce`: Zustellung einer Zusammenfassung an den Zielkanal und Posten einer kurzen Zusammenfassung in der Hauptsitzung.
  - `none`: nur intern (keine Zustellung, keine Zusammenfassung der Hauptsitzung).
- `wakeMode` steuert, wann die Zusammenfassung der Hauptsitzung gepostet wird:
  - `now`: sofortiger Heartbeat.
  - `next-heartbeat`: wartet auf den nächsten geplanten Heartbeat.

Verwenden Sie isolierte Jobs für laute, häufige oder „Hintergrundarbeiten“, die
den Verlauf Ihres Hauptchats nicht zuspammen sollen.

### Payload-Formate (was ausgeführt wird)

Es werden zwei Payload-Typen unterstützt:

- `systemEvent`: nur Hauptsitzung, durch den Heartbeat-Prompt geleitet.
- `agentTurn`: nur isolierte Sitzung, führt einen dedizierten Agent-Turn aus.

Gemeinsame `agentTurn`-Felder:

- `message`: erforderlicher Text-Prompt.
- `model` / `thinking`: optionale Overrides (siehe unten).
- `timeoutSeconds`: optionales Timeout-Override.

Zustellkonfiguration (nur isolierte Jobs):

- `delivery.mode`: `none` | `announce`.
- `delivery.channel`: `last` oder ein spezifischer Kanal.
- `delivery.to`: kanalspezifisches Ziel (Telefon-/Chat-/Kanal-ID).
- `delivery.bestEffort`: vermeidet ein Fehlschlagen des Jobs, wenn die Ankündigungszustellung fehlschlägt.

Ankündigungszustellung unterdrückt Messaging-Tool-Sends für den Lauf; verwenden Sie `delivery.channel`/`delivery.to`,
um stattdessen den Chat anzusprechen. Wenn `delivery.mode = "none"`, wird keine Zusammenfassung in der Hauptsitzung gepostet.

Wenn `delivery` für isolierte Jobs fehlt, setzt OpenClaw standardmäßig `announce`.

#### Ablauf der Ankündigungszustellung

Wenn `delivery.mode = "announce"`, stellt Cron direkt über die ausgehenden Kanaladapter zu.
Der Hauptagent wird nicht gestartet, um die Nachricht zu formulieren oder weiterzuleiten.

Verhaltensdetails:

- Inhalt: Die Zustellung verwendet die ausgehenden Payloads (Text/Medien) des isolierten Laufs mit normaler Chunking-
  und Kanalformatierung.
- Nur-Heartbeat-Antworten (`HEARTBEAT_OK` ohne echten Inhalt) werden nicht zugestellt.
- Wenn der isolierte Lauf bereits eine Nachricht an dasselbe Ziel über das Messaging-Tool gesendet hat, wird die Zustellung
  übersprungen, um Duplikate zu vermeiden.
- Fehlende oder ungültige Zustellziele lassen den Job fehlschlagen, sofern nicht `delivery.bestEffort = true`.
- Eine kurze Zusammenfassung wird nur dann in der Hauptsitzung gepostet, wenn `delivery.mode = "announce"`.
- Die Zusammenfassung der Hauptsitzung berücksichtigt `wakeMode`: `now` löst einen sofortigen Heartbeat aus und
  `next-heartbeat` wartet auf den nächsten geplanten Heartbeat.

### Modell- und Thinking-Overrides

Isolierte Jobs (`agentTurn`) können das Modell und das Thinking-Level überschreiben:

- `model`: Anbieter-/Modell-String (z. B. `anthropic/claude-sonnet-4-20250514`) oder Alias (z. B. `opus`)
- `thinking`: Thinking-Level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; nur GPT-5.2- und Codex-Modelle)

Hinweis: Sie können `model` auch bei Jobs der Hauptsitzung setzen, dies ändert jedoch das gemeinsame Modell der
Hauptsitzung. Wir empfehlen Modell-Overrides nur für isolierte Jobs, um unerwartete Kontextwechsel zu vermeiden.

Auflösungspriorität:

1. Job-Payload-Override (höchste)
2. Hook-spezifische Defaults (z. B. `hooks.gmail.model`)
3. Agent-Konfigurations-Default

### Zustellung (Kanal + Ziel)

Isolierte Jobs können Ausgaben über die Top-Level-`delivery`-Konfiguration an einen Kanal zustellen:

- `delivery.mode`: `announce` (Zusammenfassung zustellen) oder `none`.
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (Plugin) / `signal` / `imessage` / `last`.
- `delivery.to`: kanalspezifisches Empfängerziel.

Die Zustellkonfiguration ist nur für isolierte Jobs gültig (`sessionTarget: "isolated"`).

Wenn `delivery.channel` oder `delivery.to` fehlt, kann Cron auf die „letzte Route“ der Hauptsitzung
zurückfallen (der letzte Ort, an den der Agent geantwortet hat).

Hinweise zum Zielformat:

- Slack-/Discord-/Mattermost-(Plugin)-Ziele sollten explizite Präfixe verwenden (z. B. `channel:<id>`, `user:<id>`), um Mehrdeutigkeiten zu vermeiden.
- Telegram-Themen sollten das Format `:topic:` verwenden (siehe unten).

#### Telegram-Zustellziele (Themen / Forum-Threads)

Telegram unterstützt Forenthemen über `message_thread_id`. Für die Cron-Zustellung können Sie
das Thema/den Thread im Feld `to` kodieren:

- `-1001234567890` (nur Chat-ID)
- `-1001234567890:topic:123` (bevorzugt: expliziter Themenmarker)
- `-1001234567890:123` (Kurzform: numerisches Suffix)

Präfixierte Ziele wie `telegram:...` / `telegram:group:...` werden ebenfalls akzeptiert:

- `telegram:group:-1001234567890:topic:123`

## JSON-Schema für Tool-Calls

Verwenden Sie diese Formate, wenn Sie Gateway-`cron.*`-Tools direkt aufrufen (Agent-Tool-Calls oder RPC).
CLI-Flags akzeptieren menschenlesbare Dauern wie `20m`, aber Tool-Calls sollten einen ISO-8601-String
für `schedule.at` und Millisekunden für `schedule.everyMs` verwenden.

### cron.add-Parameter

Einmaliger Job der Hauptsitzung (Systemereignis):

```json
{
  "name": "Reminder",
  "schedule": { "kind": "at", "at": "2026-02-01T16:00:00Z" },
  "sessionTarget": "main",
  "wakeMode": "now",
  "payload": { "kind": "systemEvent", "text": "Reminder text" },
  "deleteAfterRun": true
}
```

Wiederkehrender, isolierter Job mit Zustellung:

```json
{
  "name": "Morning brief",
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize overnight updates."
  },
  "delivery": {
    "mode": "announce",
    "channel": "slack",
    "to": "channel:C1234567890",
    "bestEffort": true
  }
}
```

Hinweise:

- `schedule.kind`: `at` (`at`), `every` (`everyMs`) oder `cron` (`expr`, optional `tz`).
- `schedule.at` akzeptiert ISO 8601 (Zeitzone optional; bei Weglassen als UTC behandelt).
- `everyMs` sind Millisekunden.
- `sessionTarget` muss `"main"` oder `"isolated"` sein und muss zu `payload.kind` passen.
- Optionale Felder: `agentId`, `description`, `enabled`, `deleteAfterRun` (Standard true für `at`),
  `delivery`.
- `wakeMode` ist standardmäßig `"now"`, wenn es fehlt.

### cron.update-Parameter

```json
{
  "jobId": "job-123",
  "patch": {
    "enabled": false,
    "schedule": { "kind": "every", "everyMs": 3600000 }
  }
}
```

Hinweise:

- `jobId` ist kanonisch; `id` wird aus Kompatibilitätsgründen akzeptiert.
- Verwenden Sie `agentId: null` im Patch, um eine Agent-Bindung zu löschen.

### cron.run- und cron.remove-Parameter

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## Speicherung & Verlauf

- Job-Store: `~/.openclaw/cron/jobs.json` (Gateway-verwaltetes JSON).
- Ausführungsverlauf: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, automatisch bereinigt).
- Speicherpfad überschreiben: `cron.store` in der Konfiguration.

## Konfiguration

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // default 1
  },
}
```

Cron vollständig deaktivieren:

- `cron.enabled: false` (Konfiguration)
- `OPENCLAW_SKIP_CRON=1` (Env)

## CLI-Schnellstart

Einmalige Erinnerung (UTC-ISO, automatische Löschung nach Erfolg):

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

Einmalige Erinnerung (Hauptsitzung, sofort wecken):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

Wiederkehrender isolierter Job (Ankündigung an WhatsApp):

```bash
openclaw cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Wiederkehrender isolierter Job (Zustellung an ein Telegram-Thema):

```bash
openclaw cron add \
  --name "Nightly summary (topic)" \
  --cron "0 22 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize today; send to the nightly topic." \
  --announce \
  --channel telegram \
  --to "-1001234567890:topic:123"
```

Isolierter Job mit Modell- und Thinking-Override:

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Weekly deep analysis of project progress." \
  --model "opus" \
  --thinking high \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Agent-Auswahl (Multi-Agent-Setups):

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

Manueller Lauf (Force ist Standard, verwenden Sie `--due`, um nur bei Fälligkeit auszuführen):

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

Vorhandenen Job bearbeiten (Felder patchen):

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

Verlauf ausführen:

```bash
openclaw cron runs --id <jobId> --limit 50
```

Sofortiges Systemereignis ohne Job-Erstellung:

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Gateway-API-Oberfläche

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (force oder due), `cron.runs`
  Für sofortige Systemereignisse ohne Job verwenden Sie [`openclaw system event`](/cli/system).

## Fehlerbehebung

### „Nichts läuft“

- Prüfen Sie, ob Cron aktiviert ist: `cron.enabled` und `OPENCLAW_SKIP_CRON`.
- Prüfen Sie, dass das Gateway kontinuierlich läuft (Cron läuft innerhalb des Gateway-Prozesses).
- Bei `cron`-Zeitplänen: Zeitzone (`--tz`) vs. Host-Zeitzone prüfen.

### Ein wiederkehrender Job verzögert sich nach Fehlern immer weiter

- OpenClaw wendet exponentielles Retry-Backoff für wiederkehrende Jobs nach aufeinanderfolgenden Fehlern an:
  30 s, 1 min, 5 min, 15 min, dann 60 min zwischen Versuchen.
- Das Backoff wird nach dem nächsten erfolgreichen Lauf automatisch zurückgesetzt.
- Einmalige (`at`) Jobs werden nach einem terminalen Lauf (`ok`, `error` oder `skipped`) deaktiviert und nicht erneut versucht.

### Telegram liefert an den falschen Ort

- Verwenden Sie für Forenthemen `-100…:topic:<id>`, damit es explizit und eindeutig ist.
- Wenn Sie in Logs oder gespeicherten „last route“-Zielen Präfixe wie `telegram:...` sehen, ist das normal;
  die Cron-Zustellung akzeptiert sie und parst Themen-IDs weiterhin korrekt.
