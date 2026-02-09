---
summary: "„Leitfaden zur Auswahl zwischen Heartbeat und Cron-Jobs für Automatisierung“"
read_when:
  - Entscheidung, wie wiederkehrende Aufgaben geplant werden sollen
  - Einrichten von Hintergrundüberwachung oder Benachrichtigungen
  - Optimierung der Token-Nutzung für periodische Prüfungen
title: "„Cron vs. Heartbeat“"
---

# Cron vs. Heartbeat: Wann Sie was verwenden sollten

Sowohl Heartbeats als auch Cron-Jobs ermöglichen es Ihnen, Aufgaben nach einem Zeitplan auszuführen. Dieser Leitfaden hilft Ihnen, den richtigen Mechanismus für Ihren Anwendungsfall auszuwählen.

## Schnellentscheidungshilfe

| Fall verwenden                                | Empfohlen                              | Warum                                             |
| --------------------------------------------- | -------------------------------------- | ------------------------------------------------- |
| Posteingang alle 30 Min prüfen                | Heartbeat                              | Bündelt mit anderen Prüfungen, kontextbewusst     |
| Täglichen Bericht exakt um 9 Uhr senden       | Cron (isoliert)     | Exaktes Timing erforderlich                       |
| Kalender auf bevorstehende Termine überwachen | Heartbeat                              | Natürliche Lösung für periodische Aufmerksamkeit  |
| Wöchentliche Tiefenanalyse ausführen          | Cron (isoliert)     | Eigenständige Aufgabe, kann anderes Modell nutzen |
| Erinnere mich in 20 Minuten                   | Cron (main, `--at`) | Einmalig mit präzisem Timing                      |
| Hintergrund-Check zur Projektgesundheit       | Heartbeat                              | Nutzt bestehenden Zyklus mit                      |

## Heartbeat: Periodische Aufmerksamkeit

Heartbeats laufen in der **Hauptsitzung** in einem regelmäßigen Intervall (Standard: 30 Min). Sie sind dafür gedacht, dass der Agent Dinge überprüft und alles Wichtige hervorhebt.

### Wann Sie Heartbeat verwenden sollten

- **Mehrere periodische Prüfungen**: Statt 5 separater Cron-Jobs für Posteingang, Kalender, Wetter, Benachrichtigungen und Projektstatus kann ein einzelner Heartbeat all dies bündeln.
- **Kontextbewusste Entscheidungen**: Der Agent hat den vollständigen Kontext der Hauptsitzung und kann intelligent entscheiden, was dringend ist und was warten kann.
- **Konversationelle Kontinuität**: Heartbeat-Läufe teilen dieselbe Sitzung, sodass sich der Agent an kürzliche Gespräche erinnert und natürlich nachfassen kann.
- **Überwachung mit geringem Overhead**: Ein Heartbeat ersetzt viele kleine Polling-Aufgaben.

### Vorteile von Heartbeat

- **Bündelt mehrere Prüfungen**: Ein Agenten-Zug kann Posteingang, Kalender und Benachrichtigungen gemeinsam prüfen.
- **Reduziert API-Aufrufe**: Ein einzelner Heartbeat ist günstiger als 5 isolierte Cron-Jobs.
- **Kontextbewusst**: Der Agent weiß, woran Sie gearbeitet haben, und kann entsprechend priorisieren.
- **Intelligente Unterdrückung**: Wenn nichts Aufmerksamkeit erfordert, antwortet der Agent mit `HEARTBEAT_OK` und es wird keine Nachricht zugestellt.
- **Natürliches Timing**: Verschiebt sich leicht je nach Warteschlangenlast, was für die meisten Überwachungen ausreichend ist.

### Heartbeat-Beispiel: HEARTBEAT.md-Checkliste

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- If a background task finished, summarize results
- If idle for 8+ hours, send a brief check-in
```

Der Agent liest dies bei jedem Heartbeat und erledigt alle Punkte in einem Zug.

### Heartbeat konfigurieren

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // interval
        target: "last", // where to deliver alerts
        activeHours: { start: "08:00", end: "22:00" }, // optional
      },
    },
  },
}
```

Siehe [Heartbeat](/gateway/heartbeat) für die vollständige Konfiguration.

## Cron: Präzise Zeitplanung

Cron-Jobs laufen zu **exakten Zeiten** und können in isolierten Sitzungen ausgeführt werden, ohne den Hauptkontext zu beeinflussen.

### Wann Sie Cron verwenden sollten

- **Exaktes Timing erforderlich**: „Sende dies jeden Montag um 9:00 Uhr“ (nicht „irgendwann um 9“).
- **Eigenständige Aufgaben**: Aufgaben, die keinen konversationellen Kontext benötigen.
- **Anderes Modell/Denken**: Aufwendige Analysen, die ein leistungsfähigeres Modell rechtfertigen.
- **Einmalige Erinnerungen**: „Erinnere mich in 20 Minuten“ mit `--at`.
- **Lautstarke/häufige Aufgaben**: Aufgaben, die den Verlauf der Hauptsitzung überladen würden.
- **Externe Trigger**: Aufgaben, die unabhängig davon laufen sollen, ob der Agent sonst aktiv ist.

### Vorteile von Cron

- **Exaktes Timing**: 5-Feld-Cron-Ausdrücke mit Zeitzonenunterstützung.
- **Sitzungsisolation**: Läuft in `cron:<jobId>`, ohne den Hauptverlauf zu verschmutzen.
- **Modellüberschreibungen**: Verwenden Sie pro Job ein günstigeres oder leistungsfähigeres Modell.
- **Zustellkontrolle**: Isolierte Jobs verwenden standardmäßig `announce` (Zusammenfassung); wählen Sie bei Bedarf `none`.
- **Sofortige Zustellung**: Der Ankündigungsmodus postet direkt, ohne auf den Heartbeat zu warten.
- **Kein Agentenkontext nötig**: Läuft auch, wenn die Hauptsitzung inaktiv oder komprimiert ist.
- **Einmalige Ausführung**: `--at` für präzise zukünftige Zeitstempel.

### Cron-Beispiel: Tägliches Morgenbriefing

```bash
openclaw cron add \
  --name "Morning briefing" \
  --cron "0 7 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Generate today's briefing: weather, calendar, top emails, news summary." \
  --model opus \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Dies läuft exakt um 7:00 Uhr New Yorker Zeit, nutzt Opus für Qualität und kündigt eine Zusammenfassung direkt auf WhatsApp an.

### Cron-Beispiel: Einmalige Erinnerung

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

Siehe [Cron jobs](/automation/cron-jobs) für die vollständige CLI-Referenz.

## Entscheidungsflussdiagramm

```
Does the task need to run at an EXACT time?
  YES -> Use cron
  NO  -> Continue...

Does the task need isolation from main session?
  YES -> Use cron (isolated)
  NO  -> Continue...

Can this task be batched with other periodic checks?
  YES -> Use heartbeat (add to HEARTBEAT.md)
  NO  -> Use cron

Is this a one-shot reminder?
  YES -> Use cron with --at
  NO  -> Continue...

Does it need a different model or thinking level?
  YES -> Use cron (isolated) with --model/--thinking
  NO  -> Use heartbeat
```

## Kombination beider Ansätze

Die effizienteste Einrichtung nutzt **beide**:

1. **Heartbeat** übernimmt die routinemäßige Überwachung (Posteingang, Kalender, Benachrichtigungen) in einem gebündelten Zug alle 30 Minuten.
2. **Cron** übernimmt präzise Zeitpläne (tägliche Berichte, wöchentliche Reviews) und einmalige Erinnerungen.

### Beispiel: Effiziente Automatisierungseinrichtung

**HEARTBEAT.md** (alle 30 Min geprüft):

```md
# Heartbeat checklist

- Scan inbox for urgent emails
- Check calendar for events in next 2h
- Review any pending tasks
- Light check-in if quiet for 8+ hours
```

**Cron-Jobs** (präzises Timing):

```bash
# Daily morning briefing at 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Weekly project review on Mondays at 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# One-shot reminder
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster: Deterministische Workflows mit Freigaben

Lobster ist die Workflow-Laufzeit für **mehrstufige Tool-Pipelines**, die deterministische Ausführung und explizite Freigaben benötigen.
Verwenden Sie es, wenn die Aufgabe mehr als einen einzelnen Agenten-Zug umfasst und Sie einen wiederaufnehmbaren Workflow mit menschlichen Kontrollpunkten wünschen.

### Wann Lobster passt

- **Mehrstufige Automatisierung**: Sie benötigen eine feste Pipeline von Tool-Aufrufen, keinen einmaligen Prompt.
- **Genehmigungsgates**: Nebeneffekte sollten pausieren, bis du freigeschaltet hast, und dann wieder fortfahren.
- **Wiederaufnehmbare Läufe**: Setzen Sie einen pausierten Workflow fort, ohne frühere Schritte erneut auszuführen.

### Zusammenspiel mit Heartbeat und Cron

- **Heartbeat/Cron** entscheiden, _wann_ ein Lauf stattfindet.
- **Lobster** definiert, _welche Schritte_ stattfinden, sobald der Lauf startet.

Für geplante Workflows verwenden Sie Cron oder Heartbeat, um einen Agenten-Zug auszulösen, der Lobster aufruft.
Für ad-hoc-Workflows rufen Sie Lobster direkt auf.

### Operative Hinweise (aus dem Code)

- Lobster läuft als **lokaler Subprozess** (`lobster` CLI) im Tool-Modus und gibt einen **JSON-Umschlag** zurück.
- Wenn das Tool `needs_approval` zurückgibt, setzen Sie mit `resumeToken` und dem Flag `approve` fort.
- Das Tool ist ein **optionales Plugin**; aktivieren Sie es additiv über `tools.alsoAllow: ["lobster"]` (empfohlen).
- Wenn Sie `lobsterPath` übergeben, muss es ein **absoluter Pfad** sein.

Siehe [Lobster](/tools/lobster) für vollständige Nutzung und Beispiele.

## Hauptsitzung vs. isolierte Sitzung

Sowohl Heartbeat als auch Cron können mit der Hauptsitzung interagieren, jedoch unterschiedlich:

|         | Heartbeat                             | Cron (main)                | Cron (isoliert)                       |
| ------- | ------------------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| Sitzung | Main                                  | Main (über Systemereignis) | `cron:<jobId>`                                           |
| Verlauf | Geteilt                               | Geteilt                                       | Bei jedem Lauf neu                                       |
| Kontext | Vollständig                           | Vollständig                                   | Keiner (startet sauber)               |
| Modell  | Modell der Hauptsitzung               | Modell der Hauptsitzung                       | Kann überschrieben werden                                |
| Ausgabe | Zugestellt, wenn nicht `HEARTBEAT_OK` | Heartbeat-Prompt + Ereignis                   | Zusammenfassung ankündigen (Standard) |

### Wann Sie Cron in der Hauptsitzung verwenden sollten

Verwenden Sie `--session main` mit `--system-event`, wenn Sie Folgendes möchten:

- Die Erinnerung/das Ereignis soll im Kontext der Hauptsitzung erscheinen
- Der Agent soll es beim nächsten Heartbeat mit vollem Kontext verarbeiten
- Kein separater isolierter Lauf

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### Wann Sie isolierten Cron verwenden sollten

Verwenden Sie `--session isolated`, wenn Sie Folgendes möchten:

- Ein unbeschriebenes Blatt ohne vorherigen Kontext
- Andere Modell- oder Denk-Einstellungen
- Zusammenfassungen direkt in einem Kanal ankündigen
- Verlauf, der die Hauptsitzung nicht überlädt

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 0" \
  --session isolated \
  --message "Weekly codebase analysis..." \
  --model opus \
  --thinking high \
  --announce
```

## Kostenüberlegungen

| Mechanismus                        | Kostenprofil                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| Heartbeat                          | Ein Zug alle N Minuten; skaliert mit der Größe von HEARTBEAT.md     |
| Cron (main)     | Fügt Ereignis zum nächsten Heartbeat hinzu (kein isolierter Zug) |
| Cron (isoliert) | Voller Agenten-Zug pro Job; kann günstigeres Modell nutzen                          |

**Tipps**:

- Halten Sie `HEARTBEAT.md` klein, um den Token-Overhead zu minimieren.
- Bündeln Sie ähnliche Prüfungen in Heartbeat statt in mehreren Cron-Jobs.
- Verwenden Sie `target: "none"` bei Heartbeat, wenn Sie nur interne Verarbeitung wünschen.
- Nutzen Sie isolierten Cron mit einem günstigeren Modell für Routineaufgaben.

## Verwandt

- [Heartbeat](/gateway/heartbeat) – vollständige Heartbeat-Konfiguration
- [Cron jobs](/automation/cron-jobs) – vollständige Cron-CLI- und API-Referenz
- [System](/cli/system) – Systemereignisse + Heartbeat-Steuerung
