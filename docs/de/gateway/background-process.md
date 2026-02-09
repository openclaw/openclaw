---
summary: "„Ausführung im Hintergrund und Prozessverwaltung“"
read_when:
  - Hinzufügen oder Ändern des Verhaltens der Hintergrundausführung
  - Debuggen von lang laufenden Exec-Aufgaben
title: "„Background Exec und Process Tool“"
---

# Background Exec + Process Tool

OpenClaw führt Shell-Befehle über das Tool `exec` aus und hält lang laufende Aufgaben im Speicher. Das Tool `process` verwaltet diese Hintergrundsitzungen.

## exec tool

Wichtige Parameter:

- `command` (erforderlich)
- `yieldMs` (Standard 10000): automatisches Verschieben in den Hintergrund nach dieser Verzögerung
- `background` (bool): sofort im Hintergrund starten
- `timeout` (Sekunden, Standard 1800): beendet den Prozess nach diesem Timeout
- `elevated` (bool): auf dem Host ausführen, wenn der erhöhte Modus aktiviert/erlaubt ist
- Benötigen Sie ein echtes TTY? Setzen Sie `pty: true`.
- `workdir`, `env`

Verhalten:

- Vordergrundausführungen geben die Ausgabe direkt zurück.
- Bei Ausführung im Hintergrund (explizit oder durch Timeout) gibt das Tool `status: "running"` + `sessionId` sowie einen kurzen Tail zurück.
- Die Ausgabe wird im Speicher gehalten, bis die Sitzung abgefragt oder gelöscht wird.
- Wenn das Tool `process` nicht erlaubt ist, läuft `exec` synchron und ignoriert `yieldMs`/`background`.

## Child-Process-Bridging

Beim Starten lang laufender Child-Prozesse außerhalb der Exec-/Process-Tools (zum Beispiel bei CLI-Neustarts oder Gateway-Hilfsprozessen) sollten Sie den Child-Process-Bridge-Helper anhängen, damit Beendigungssignale weitergeleitet und Listener bei Exit/Fehler getrennt werden. Dies vermeidet verwaiste Prozesse unter systemd und sorgt für konsistentes Shutdown-Verhalten über alle Plattformen hinweg.

Umgebungs-Overrides:

- `PI_BASH_YIELD_MS`: Standard-Yield (ms)
- `PI_BASH_MAX_OUTPUT_CHARS`: In-Memory-Ausgabegrenze (Zeichen)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`: Grenze für ausstehende stdout/stderr pro Stream (Zeichen)
- `PI_BASH_JOB_TTL_MS`: TTL für abgeschlossene Sitzungen (ms, begrenzt auf 1 Min.–3 Std.)

Konfiguration (bevorzugt):

- `tools.exec.backgroundMs` (Standard 10000)
- `tools.exec.timeoutSec` (Standard 1800)
- `tools.exec.cleanupMs` (Standard 1800000)
- `tools.exec.notifyOnExit` (Standard true): stellt beim Beenden einer im Hintergrund ausgeführten Exec einen System-Event in die Warteschlange und fordert einen Heartbeat an.

## process tool

Aktionen:

- `list`: laufende + abgeschlossene Sitzungen
- `poll`: neue Ausgabe für eine Sitzung abziehen (meldet auch den Exit-Status)
- `log`: aggregierte Ausgabe lesen (unterstützt `offset` + `limit`)
- `write`: stdin senden (`data`, optional `eof`)
- `kill`: eine Hintergrundsitzung beenden
- `clear`: eine abgeschlossene Sitzung aus dem Speicher entfernen
- `remove`: beenden, wenn laufend, andernfalls löschen, wenn abgeschlossen

Hinweise:

- Nur im Hintergrund ausgeführte Sitzungen werden aufgelistet bzw. im Speicher gehalten.
- Sitzungen gehen bei einem Prozessneustart verloren (keine Persistenz auf Datenträger).
- Sitzungsprotokolle werden nur im Chat-Verlauf gespeichert, wenn Sie `process poll/log` ausführen und das Tool-Ergebnis aufgezeichnet wird.
- `process` ist pro Agent begrenzt; es sieht nur Sitzungen, die von diesem Agent gestartet wurden.
- `process list` enthält ein abgeleitetes `name` (Befehlsverb + Ziel) für schnelle Übersichten.
- `process log` verwendet zeilenbasiertes `offset`/`limit` (lassen Sie `offset` weg, um die letzten N Zeilen zu erhalten).

## Beispiele

Eine lange Aufgabe ausführen und später abfragen:

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

Sofort im Hintergrund starten:

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

stdin senden:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
