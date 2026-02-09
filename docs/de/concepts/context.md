---
summary: "Kontext: was das Modell sieht, wie er aufgebaut ist und wie Sie ihn prüfen"
read_when:
  - Sie möchten verstehen, was „Kontext“ in OpenClaw bedeutet
  - Sie debuggen, warum das Modell etwas „weiß“ (oder vergessen hat)
  - Sie möchten den Kontext-Overhead reduzieren (/context, /status, /compact)
title: "Kontext"
---

# Kontext

„Kontext“ ist **alles, was OpenClaw für einen Lauf an das Modell sendet**. Er ist durch das **Kontextfenster** des Modells (Token-Limit) begrenzt.

Mentales Modell für Einsteiger:

- **System-Prompt** (von OpenClaw erstellt): Regeln, Werkzeuge, Skills-Liste, Zeit/Laufzeit und injizierte Workspace-Dateien.
- **Gesprächsverlauf**: Ihre Nachrichten + die Nachrichten des Assistenten für diese Sitzung.
- **Werkzeugaufrufe/-ergebnisse + Anhänge**: Befehlsausgaben, Dateizugriffe, Bilder/Audio usw.

Kontext ist _nicht dasselbe_ wie „Speicher“: Speicher kann auf der Festplatte abgelegt und später wieder geladen werden; Kontext ist das, was sich aktuell im Fenster des Modells befindet.

## Schnellstart (Kontext prüfen)

- `/status` → schnelle Ansicht „wie voll ist mein Fenster?“ + Sitzungseinstellungen.
- `/context list` → was injiziert wird + grobe Größen (pro Datei + Summen).
- `/context detail` → detaillierte Aufschlüsselung: pro Datei, pro Werkzeug-Schema, pro Skill-Eintrag und Größe des System-Prompts.
- `/usage tokens` → hängt an normale Antworten eine Nutzungs-Fußzeile pro Antwort an.
- `/compact` → fasst ältere Historie zu einem kompakten Eintrag zusammen, um Platz im Fenster freizugeben.

Siehe auch: [Slash commands](/tools/slash-commands), [Token use & costs](/reference/token-use), [Compaction](/concepts/compaction).

## Beispielausgabe

Werte variieren je nach Modell, Anbieter, Werkzeugrichtlinie und dem Inhalt Ihres Workspace.

### `/context list`

```
🧠 Context breakdown
Workspace: <workspaceDir>
Bootstrap max/file: 20,000 chars
Sandbox: mode=non-main sandboxed=false
System prompt (run): 38,412 chars (~9,603 tok) (Project Context 23,901 chars (~5,976 tok))

Injected workspace files:
- AGENTS.md: OK | raw 1,742 chars (~436 tok) | injected 1,742 chars (~436 tok)
- SOUL.md: OK | raw 912 chars (~228 tok) | injected 912 chars (~228 tok)
- TOOLS.md: TRUNCATED | raw 54,210 chars (~13,553 tok) | injected 20,962 chars (~5,241 tok)
- IDENTITY.md: OK | raw 211 chars (~53 tok) | injected 211 chars (~53 tok)
- USER.md: OK | raw 388 chars (~97 tok) | injected 388 chars (~97 tok)
- HEARTBEAT.md: MISSING | raw 0 | injected 0
- BOOTSTRAP.md: OK | raw 0 chars (~0 tok) | injected 0 chars (~0 tok)

Skills list (system prompt text): 2,184 chars (~546 tok) (12 skills)
Tools: read, edit, write, exec, process, browser, message, sessions_send, …
Tool list (system prompt text): 1,032 chars (~258 tok)
Tool schemas (JSON): 31,988 chars (~7,997 tok) (counts toward context; not shown as text)
Tools: (same as above)

Session tokens (cached): 14,250 total / ctx=32,000
```

### `/context detail`

```
🧠 Context breakdown (detailed)
…
Top skills (prompt entry size):
- frontend-design: 412 chars (~103 tok)
- oracle: 401 chars (~101 tok)
… (+10 more skills)

Top tools (schema size):
- browser: 9,812 chars (~2,453 tok)
- exec: 6,240 chars (~1,560 tok)
… (+N more tools)
```

## Was zum Kontextfenster zählt

Alles, was das Modell erhält, zählt dazu, einschließlich:

- System-Prompt (alle Abschnitte).
- Gesprächsverlauf.
- Werkzeugaufrufe + Werkzeugergebnisse.
- Anhänge/Transkripte (Bilder/Audio/Dateien).
- Kompaktionszusammenfassungen und Pruning-Artefakte.
- Anbieter-„Wrapper“ oder versteckte Header (nicht sichtbar, zählen trotzdem).

## Wie OpenClaw den System-Prompt erstellt

Der System-Prompt gehört **OpenClaw** und wird bei jedem Lauf neu aufgebaut. Er umfasst:

- Werkzeugliste + kurze Beschreibungen.
- Skills-Liste (nur Metadaten; siehe unten).
- Workspace-Speicherort.
- Zeit (UTC + konvertierte Benutzerzeit, falls konfiguriert).
- Laufzeit-Metadaten (Host/OS/Modell/Thinking).
- Injizierte Workspace-Bootstrap-Dateien unter **Project Context**.

Vollständige Aufschlüsselung: [System Prompt](/concepts/system-prompt).

## Injizierte Workspace-Dateien (Project Context)

Standardmäßig injiziert OpenClaw einen festen Satz an Workspace-Dateien (falls vorhanden):

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (nur beim ersten Lauf)

Große Dateien werden pro Datei mit `agents.defaults.bootstrapMaxChars` gekürzt (Standard `20000` Zeichen). `/context` zeigt **Roh- vs. injizierte** Größen und ob eine Kürzung stattgefunden hat.

## Skills: was injiziert wird vs. bedarfsweise geladen

Der System-Prompt enthält eine kompakte **Skills-Liste** (Name + Beschreibung + Speicherort). Diese Liste verursacht realen Overhead.

Skill-Anweisungen sind standardmäßig _nicht_ enthalten. Vom Modell wird erwartet, dass es `read` die `SKILL.md` des Skills **nur bei Bedarf**.

## Werkzeuge: es gibt zwei Kosten

Werkzeuge beeinflussen den Kontext auf zwei Arten:

1. **Werkzeuglisten-Text** im System-Prompt (das, was Sie als „Tooling“ sehen).
2. **Werkzeug-Schemas** (JSON). Diese werden an das Modell gesendet, damit es Werkzeuge aufrufen kann. Sie zählen zum Kontext, auch wenn Sie sie nicht als Klartext sehen.

`/context detail` schlüsselt die größten Werkzeug-Schemas auf, damit Sie sehen können, was dominiert.

## Befehle, Direktiven und „Inline-Shortcuts“

Slash-Befehle werden vom Gateway verarbeitet. Es gibt einige unterschiedliche Verhaltensweisen:

- **Eigenständige Befehle**: Eine Nachricht, die nur `/...` ist, wird als Befehl ausgeführt.
- **Direktiven**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/model`, `/queue` werden entfernt, bevor das Modell die Nachricht sieht.
  - Nachrichten, die nur aus Direktiven bestehen, speichern Sitzungseinstellungen.
  - Inline-Direktiven in einer normalen Nachricht wirken als Hinweise pro Nachricht.
- **Inline-Shortcuts** (nur Allowlist-Absender): Bestimmte `/...`-Tokens innerhalb einer normalen Nachricht können sofort ausgeführt werden (Beispiel: „hey /status“) und werden entfernt, bevor das Modell den verbleibenden Text sieht.

Details: [Slash commands](/tools/slash-commands).

## Sitzungen, Kompaktierung und Pruning (was bestehen bleibt)

Was über Nachrichten hinweg bestehen bleibt, hängt vom Mechanismus ab:

- **Normaler Verlauf** bleibt im Sitzungsprotokoll, bis er durch Richtlinien kompaktierte/geschnitten wird.
- **Kompaktierung** speichert eine Zusammenfassung im Protokoll und lässt aktuelle Nachrichten intakt.
- **Pruning** entfernt alte Werkzeugergebnisse aus dem _in-memory_-Prompt für einen Lauf, schreibt das Protokoll jedoch nicht um.

Doku: [Session](/concepts/session), [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning).

## Was `/context` tatsächlich meldet

`/context` bevorzugt den neuesten **run-built** System-Prompt-Bericht, sofern verfügbar:

- `System prompt (run)` = aus dem letzten eingebetteten (werkzeugfähigen) Lauf erfasst und im Sitzungsspeicher persistiert.
- `System prompt (estimate)` = ad hoc berechnet, wenn kein Laufbericht existiert (oder bei Ausführung über ein CLI-Backend, das keinen Bericht erzeugt).

In beiden Fällen meldet es Größen und Hauptverursacher; es gibt **nicht** den vollständigen System-Prompt oder Werkzeug-Schemas aus.
