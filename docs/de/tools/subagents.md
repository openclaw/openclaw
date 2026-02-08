---
summary: "Sub-Agents: Starten isolierter Agentenläufe, die Ergebnisse an den anfordernden Chat zurückmelden"
read_when:
  - Sie möchten Hintergrund-/Parallelarbeit über den Agenten ausführen
  - Sie ändern sessions_spawn oder die Sub-Agent-Werkzeugrichtlinie
title: "Sub-Agents"
x-i18n:
  source_path: tools/subagents.md
  source_hash: 3c83eeed69a65dbb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:37:46Z
---

# Sub-Agents

Sub-Agents sind Hintergrund-Agentenläufe, die aus einem bestehenden Agentenlauf heraus gestartet werden. Sie laufen in ihrer eigenen Sitzung (`agent:<agentId>:subagent:<uuid>`) und **kündigen** nach Abschluss ihr Ergebnis im anfordernden Chat-Kanal an.

## Slash-Befehl

Verwenden Sie `/subagents`, um Sub-Agent-Läufe für die **aktuelle Sitzung** zu prüfen oder zu steuern:

- `/subagents list`
- `/subagents stop <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`

`/subagents info` zeigt Metadaten zum Lauf an (Status, Zeitstempel, Sitzungs-ID, Transkriptpfad, Bereinigung).

Primäre Ziele:

- Parallelisierung von „Recherche-/Langzeitaufgaben/langsamen Werkzeugen“, ohne den Hauptlauf zu blockieren.
- Sub-Agents standardmäßig isoliert halten (Sitzungstrennung + optionales sandboxing).
- Die Werkzeugoberfläche schwer missbrauchbar halten: Sub-Agents erhalten standardmäßig **keine** Sitzungswerkzeuge.
- Verschachteltes Fan-out vermeiden: Sub-Agents können keine Sub-Agents starten.

Kostenhinweis: Jeder Sub-Agent hat seinen **eigenen** Kontext und Tokenverbrauch. Für schwere oder repetitive
Aufgaben sollten Sie für Sub-Agents ein günstigeres Modell festlegen und Ihren Hauptagenten auf einem höherwertigen Modell belassen.
Sie können dies über `agents.defaults.subagents.model` oder per Agent-Overrides konfigurieren.

## Werkzeug

Verwenden Sie `sessions_spawn`:

- Startet einen Sub-Agent-Lauf (`deliver: false`, globale Lane: `subagent`)
- Führt anschließend einen Announce-Schritt aus und postet die Announce-Antwort in den anfordernden Chat-Kanal
- Standardmodell: übernimmt das des Aufrufers, sofern Sie nicht `agents.defaults.subagents.model` (oder pro Agent `agents.list[].subagents.model`) setzen; ein explizites `sessions_spawn.model` hat weiterhin Vorrang.
- Standarddenken: übernimmt das des Aufrufers, sofern Sie nicht `agents.defaults.subagents.thinking` (oder pro Agent `agents.list[].subagents.thinking`) setzen; ein explizites `sessions_spawn.thinking` hat weiterhin Vorrang.

Werkzeugparameter:

- `task` (erforderlich)
- `label?` (optional)
- `agentId?` (optional; Start unter einer anderen Agent-ID, falls erlaubt)
- `model?` (optional; überschreibt das Sub-Agent-Modell; ungültige Werte werden übersprungen und der Sub-Agent läuft mit dem Standardmodell, mit einer Warnung im Werkzeugergebnis)
- `thinking?` (optional; überschreibt die Denkstufe für den Sub-Agent-Lauf)
- `runTimeoutSeconds?` (Standard `0`; wenn gesetzt, wird der Sub-Agent-Lauf nach N Sekunden abgebrochen)
- `cleanup?` (`delete|keep`, Standard `keep`)

Allowlist:

- `agents.list[].subagents.allowAgents`: Liste von Agent-IDs, die über `agentId` adressiert werden können (`["*"]`, um alle zu erlauben). Standard: nur der anfordernde Agent.

Discovery:

- Verwenden Sie `agents_list`, um zu sehen, welche Agent-IDs aktuell für `sessions_spawn` erlaubt sind.

Auto-Archivierung:

- Sub-Agent-Sitzungen werden nach `agents.defaults.subagents.archiveAfterMinutes` automatisch archiviert (Standard: 60).
- Die Archivierung verwendet `sessions.delete` und benennt das Transkript in `*.deleted.<timestamp>` um (gleicher Ordner).
- `cleanup: "delete"` archiviert unmittelbar nach dem Announce (behält das Transkript dennoch per Umbenennung).
- Auto-Archivierung ist Best-Effort; ausstehende Timer gehen verloren, wenn das Gateway neu startet.
- `runTimeoutSeconds` archiviert **nicht** automatisch; es stoppt nur den Lauf. Die Sitzung bleibt bis zur Auto-Archivierung bestehen.

## Authentifizierung

Die Sub-Agent-Authentifizierung wird nach **Agent-ID** aufgelöst, nicht nach Sitzungstyp:

- Der Sub-Agent-Sitzungsschlüssel ist `agent:<agentId>:subagent:<uuid>`.
- Der Auth-Speicher wird aus der `agentDir` dieses Agenten geladen.
- Die Auth-Profile des Hauptagenten werden als **Fallback** zusammengeführt; bei Konflikten überschreiben Agent-Profile die Hauptprofile.

Hinweis: Die Zusammenführung ist additiv, daher stehen Hauptprofile immer als Fallbacks zur Verfügung. Vollständig isolierte Authentifizierung pro Agent wird derzeit noch nicht unterstützt.

## Announce

Sub-Agents melden sich über einen Announce-Schritt zurück:

- Der Announce-Schritt läuft innerhalb der Sub-Agent-Sitzung (nicht der anfordernden Sitzung).
- Wenn der Sub-Agent exakt `ANNOUNCE_SKIP` antwortet, wird nichts gepostet.
- Andernfalls wird die Announce-Antwort über einen Folgeaufruf von `agent` (`deliver=true`) in den anfordernden Chat-Kanal gepostet.
- Announce-Antworten bewahren, sofern verfügbar, Thread-/Themen-Routing (Slack-Threads, Telegram-Themen, Matrix-Threads).
- Announce-Nachrichten werden auf eine stabile Vorlage normalisiert:
  - `Status:`, abgeleitet aus dem Laufergebnis (`success`, `error`, `timeout` oder `unknown`).
  - `Result:` der Zusammenfassungsinhalt aus dem Announce-Schritt (oder `(not available)`, falls fehlend).
  - `Notes:` Fehlerdetails und weiterer nützlicher Kontext.
- `Status` wird nicht aus der Modellausgabe abgeleitet; es stammt aus Laufzeit-Ergebnissignalen.

Announce-Payloads enthalten am Ende eine Statistikzeile (auch bei Umbruch):

- Laufzeit (z. B. `runtime 5m12s`)
- Tokenverbrauch (Eingabe/Ausgabe/Gesamt)
- Geschätzte Kosten, wenn Modellpreise konfiguriert sind (`models.providers.*.models[].cost`)
- `sessionKey`, `sessionId` und Transkriptpfad (damit der Hauptagent den Verlauf über `sessions_history` abrufen oder die Datei auf dem Datenträger prüfen kann)

## Werkzeugrichtlinie (Sub-Agent-Werkzeuge)

Standardmäßig erhalten Sub-Agents **alle Werkzeuge außer Sitzungswerkzeuge**:

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

Überschreiben über Konfiguration:

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxConcurrent: 1,
      },
    },
  },
  tools: {
    subagents: {
      tools: {
        // deny wins
        deny: ["gateway", "cron"],
        // if allow is set, it becomes allow-only (deny still wins)
        // allow: ["read", "exec", "process"]
      },
    },
  },
}
```

## Nebenläufigkeit

Sub-Agents verwenden eine dedizierte In-Process-Warteschlangen-Lane:

- Lane-Name: `subagent`
- Nebenläufigkeit: `agents.defaults.subagents.maxConcurrent` (Standard `8`)

## Beenden

- Das Senden von `/stop` im anfordernden Chat bricht die anfordernde Sitzung ab und stoppt alle aktiven Sub-Agent-Läufe, die daraus gestartet wurden.

## Einschränkungen

- Sub-Agent-Announce ist **Best-Effort**. Wenn das Gateway neu startet, gehen ausstehende „Zurückmelden“-Arbeiten verloren.
- Sub-Agents teilen weiterhin dieselben Gateway-Prozessressourcen; behandeln Sie `maxConcurrent` als Sicherheitsventil.
- `sessions_spawn` ist immer nicht blockierend: Es gibt sofort `{ status: "accepted", runId, childSessionKey }` zurück.
- Der Sub-Agent-Kontext injiziert nur `AGENTS.md` + `TOOLS.md` (kein `SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md` oder `BOOTSTRAP.md`).
