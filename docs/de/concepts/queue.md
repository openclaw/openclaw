---
summary: "„Design der Befehlswarteschlange, das eingehende Auto-Reply-Ausführungen serialisiert“"
read_when:
  - Beim Ändern der Auto-Reply-Ausführung oder -Nebenläufigkeit
title: "Befehlswarteschlange"
---

# Befehlswarteschlange (2026-01-16)

Wir serialisieren eingehende Auto-Reply-Ausführungen (alle Kanäle) über eine kleine In-Process-Warteschlange, um Kollisionen mehrerer Agent-Ausführungen zu verhindern, und erlauben gleichzeitig sichere Parallelität über Sitzungen hinweg.

## Warum

- Auto-Reply-Ausführungen können teuer sein (LLM-Aufrufe) und kollidieren, wenn mehrere eingehende Nachrichten kurz hintereinander eintreffen.
- Serialisierung vermeidet Konkurrenz um gemeinsam genutzte Ressourcen (Sitzungsdateien, Logs, CLI-stdin) und reduziert die Wahrscheinlichkeit von Upstream-Ratenbegrenzungen.

## Wie es funktioniert

- Eine lane-bewusste FIFO-Warteschlange leert jede Lane mit einer konfigurierbaren Nebenläufigkeitsgrenze (Standard: 1 für nicht konfigurierte Lanes; main standardmäßig 4, subagent 8).
- `runEmbeddedPiAgent` reiht nach **Sitzungsschlüssel** (Lane `session:<key>`) ein, um sicherzustellen, dass pro Sitzung nur eine aktive Ausführung existiert.
- Jede Sitzungs-Ausführung wird anschließend in eine **globale Lane** (standardmäßig `main`) eingereiht, sodass die Gesamtparallelität durch `agents.defaults.maxConcurrent` begrenzt ist.
- Wenn ausführliches Logging aktiviert ist, geben eingereihte Ausführungen einen kurzen Hinweis aus, falls sie vor dem Start länger als ~2 s gewartet haben.
- Tippindikatoren werden weiterhin sofort beim Enqueue ausgelöst (sofern vom Kanal unterstützt), sodass die Benutzererfahrung unverändert bleibt, während wir auf unseren Zug warten.

## Warteschlangenmodi (pro Kanal)

Eingehende Nachrichten können die aktuelle Ausführung steuern, auf einen Folgezug warten oder beides:

- `steer`: sofort in die aktuelle Ausführung injizieren (bricht ausstehende Werkzeugaufrufe nach der nächsten Werkzeuggrenze ab). Falls nicht streamingfähig, Fallback auf Follow-up.
- `followup`: für den nächsten Agent-Zug nach Ende der aktuellen Ausführung einreihen.
- `collect`: alle eingereihten Nachrichten zu einem **einzigen** Follow-up-Zug zusammenfassen (Standard). Wenn Nachrichten unterschiedliche Kanäle/Threads adressieren, werden sie einzeln abgearbeitet, um das Routing zu erhalten.
- `steer-backlog` (alias `steer+backlog`): jetzt steuern **und** die Nachricht für einen Follow-up-Zug behalten.
- `interrupt` (Legacy): die aktive Ausführung für diese Sitzung abbrechen und dann die neueste Nachricht ausführen.
- `queue` (Legacy-Alias): identisch mit `steer`.

Steer-backlog bedeutet, dass Sie nach der gesteuerten Ausführung eine Follow-up-Antwort erhalten können; Streaming-Oberflächen können daher wie Duplikate aussehen. Bevorzugen Sie `collect`/`steer`, wenn Sie
eine Antwort pro eingehender Nachricht wünschen.
Senden Sie `/queue collect` als eigenständigen Befehl (pro Sitzung) oder setzen Sie `messages.queue.byChannel.discord: "collect"`.

Standardwerte (wenn in der Konfiguration nicht gesetzt):

- Alle Oberflächen → `collect`

Global oder pro Kanal über `messages.queue` konfigurieren:

```json5
{
  messages: {
    queue: {
      mode: "collect",
      debounceMs: 1000,
      cap: 20,
      drop: "summarize",
      byChannel: { discord: "collect" },
    },
  },
}
```

## Warteschlangenoptionen

Optionen gelten für `followup`, `collect` und `steer-backlog` (sowie für `steer`, wenn es auf Follow-up zurückfällt):

- `debounceMs`: vor dem Start eines Follow-up-Zugs auf Ruhe warten (verhindert „continue, continue“).
- `cap`: maximale Anzahl eingereihter Nachrichten pro Sitzung.
- `drop`: Überlaufstrategie (`old`, `new`, `summarize`).

„Summarize“ behält eine kurze Stichpunktliste verworfener Nachrichten und injiziert sie als synthetischen Follow-up-Prompt.
Standardwerte: `debounceMs: 1000`, `cap: 20`, `drop: summarize`.

## Sitzungsüberschreibungen

- Senden Sie `/queue <mode>` als eigenständigen Befehl, um den Modus für die aktuelle Sitzung zu speichern.
- Optionen können kombiniert werden: `/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` oder `/queue reset` hebt das Sitzungs-Override auf.

## Geltungsbereich und Garantien

- Gilt für Auto-Reply-Agent-Ausführungen über alle eingehenden Kanäle, die die Gateway-Antwort-Pipeline verwenden (WhatsApp Web, Telegram, Slack, Discord, Signal, iMessage, Webchat usw.).
- Die Standard-Lane (`main`) gilt pro Prozess für eingehende Nachrichten + Main-Heartbeats; setzen Sie `agents.defaults.maxConcurrent`, um mehrere Sitzungen parallel zuzulassen.
- Zusätzliche Lanes können existieren (z. B. `cron`, `subagent`), sodass Hintergrundjobs parallel laufen können, ohne eingehende Antworten zu blockieren.
- Pro-Sitzung-Lanes garantieren, dass jeweils nur eine Agent-Ausführung eine bestimmte Sitzung berührt.
- Keine externen Abhängigkeiten oder Hintergrund-Worker-Threads; reines TypeScript + Promises.

## Fehlerbehebung

- Wenn Befehle festzustecken scheinen, aktivieren Sie ausführliche Logs und suchen Sie nach Zeilen „queued for …ms“, um zu bestätigen, dass die Warteschlange abgearbeitet wird.
- Wenn Sie die Warteschlangentiefe benötigen, aktivieren Sie ausführliche Logs und achten Sie auf Timing-Zeilen der Warteschlange.
