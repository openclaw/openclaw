---
summary: "Agent-Laufzeit (eingebettetes pi-mono), Workspace-Vertrag und Sitzungs-Bootstrap"
read_when:
  - Beim Ändern der Agent-Laufzeit, des Workspace-Bootstraps oder des Sitzungsverhaltens
title: "Agent-Laufzeit"
---

# Agent-Laufzeit 🤖

OpenClaw betreibt eine einzelne eingebettete Agent-Laufzeit, die von **pi-mono** abgeleitet ist.

## Workspace (erforderlich)

OpenClaw verwendet ein einzelnes Agent-Workspace-Verzeichnis (`agents.defaults.workspace`) als **einziges** Arbeitsverzeichnis (`cwd`) des Agenten für Werkzeuge und Kontext.

Empfohlen: Verwenden Sie `openclaw setup`, um `~/.openclaw/openclaw.json` zu erstellen, falls es fehlt, und initialisieren Sie die Workspace-Dateien.

Vollständiges Workspace-Layout + Backup-Leitfaden: [Agent workspace](/concepts/agent-workspace)

Wenn `agents.defaults.sandbox` aktiviert ist, können Nicht-Hauptsitzungen dies mit
sitzungsspezifischen Workspaces unter `agents.defaults.sandbox.workspaceRoot` überschreiben (siehe
[Gateway configuration](/gateway/configuration)).

## Bootstrap-Dateien (injiziert)

Innerhalb von `agents.defaults.workspace` erwartet OpenClaw diese benutzerbearbeitbaren Dateien:

- `AGENTS.md` — Betriebsanweisungen + „Gedächtnis“
- `SOUL.md` — Persona, Grenzen, Ton
- `TOOLS.md` — vom Benutzer gepflegte Werkzeugnotizen (z. B. `imsg`, `sag`, Konventionen)
- `BOOTSTRAP.md` — einmaliges Ritual beim ersten Start (wird nach Abschluss gelöscht)
- `IDENTITY.md` — Agentenname/-vibe/-Emoji
- `USER.md` — Benutzerprofil + bevorzugte Anrede

Beim ersten Zug einer neuen Sitzung injiziert OpenClaw den Inhalt dieser Dateien direkt in den Agentenkontext.

Leere Dateien werden übersprungen. Große Dateien werden gekürzt und mit einer Markierung abgeschnitten, damit Prompts schlank bleiben (lesen Sie die Datei für den vollständigen Inhalt).

Wenn eine Datei fehlt, injiziert OpenClaw eine einzelne „missing file“-Markierungszeile (und `openclaw setup` erstellt eine sichere Standardvorlage).

`BOOTSTRAP.md` wird nur für einen **brandneuen Workspace** erstellt (keine anderen Bootstrap-Dateien vorhanden). Wenn Sie es nach Abschluss des Rituals löschen, sollte es bei späteren Neustarts nicht erneut erstellt werden.

Um die Erstellung von Bootstrap-Dateien vollständig zu deaktivieren (für vorab befüllte Workspaces), setzen Sie:

```json5
{ agent: { skipBootstrap: true } }
```

## Integrierte Werkzeuge

Kernwerkzeuge (read/exec/edit/write und verwandte Systemwerkzeuge) sind immer verfügbar,
vorbehaltlich der Werkzeugrichtlinie. `apply_patch` ist optional und wird durch
`tools.exec.applyPatch` gesteuert. `TOOLS.md` steuert **nicht**, welche Werkzeuge existieren; es ist
eine Anleitung dafür, wie _Sie_ deren Nutzung wünschen.

## Skills

OpenClaw lädt Skills aus drei Speicherorten (bei Namenskonflikten gewinnt der Workspace):

- Gebündelt (mit der Installation ausgeliefert)
- Verwaltet/lokal: `~/.openclaw/skills`
- Workspace: `<workspace>/skills`

Skills können durch Konfiguration/Umgebungsvariablen gesteuert werden (siehe `skills` in [Gateway configuration](/gateway/configuration)).

## pi-mono-Integration

OpenClaw nutzt Teile der pi-mono-Codebasis (Modelle/Werkzeuge) wieder, aber **Sitzungsverwaltung, Discovery und Werkzeugverdrahtung gehören OpenClaw**.

- Keine pi-coding-Agent-Laufzeit.
- Es werden keine `~/.pi/agent`- oder `<workspace>/.pi`-Einstellungen berücksichtigt.

## Sitzungen

Sitzungsprotokolle werden als JSONL gespeichert unter:

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

Die Sitzungs-ID ist stabil und wird von OpenClaw gewählt.
Legacy-Pi/Tau-Sitzungsordner werden **nicht** gelesen.

## Steuerung während des Streamings

Wenn der Queue-Modus `steer` ist, werden eingehende Nachrichten in den aktuellen Lauf injiziert.
Die Queue wird **nach jedem Werkzeugaufruf** geprüft; ist eine wartende Nachricht vorhanden,
werden verbleibende Werkzeugaufrufe aus der aktuellen Assistant-Nachricht übersprungen (Fehler-Werkzeugergebnisse mit „Skipped due to queued user message.“), anschließend wird die wartende Benutzernachricht vor der nächsten Assistant-Antwort injiziert.

Wenn der Queue-Modus `followup` oder `collect` ist, werden eingehende Nachrichten gehalten, bis der
aktuelle Zug endet; anschließend startet ein neuer Agentenzug mit den wartenden Nutzlasten. Siehe
[Queue](/concepts/queue) für Modus- sowie Debounce-/Cap-Verhalten.

Block-Streaming sendet abgeschlossene Assistant-Blöcke, sobald sie fertig sind; es ist
**standardmäßig deaktiviert** (`agents.defaults.blockStreamingDefault: "off"`).
Stellen Sie die Grenze über `agents.defaults.blockStreamingBreak` ein (`text_end` vs. `message_end`; Standard ist text_end).
Steuern Sie das weiche Block-Chunking mit `agents.defaults.blockStreamingChunk` (Standard:
800–1200 Zeichen; bevorzugt Absatzumbrüche, dann Zeilenumbrüche; zuletzt Sätze).
Fassen Sie gestreamte Chunks mit `agents.defaults.blockStreamingCoalesce` zusammen, um
Einzeilen-Spam zu reduzieren (leerlaufbasierte Zusammenführung vor dem Senden). Nicht-Telegram-Kanäle erfordern
explizit `*.blockStreaming: true`, um Block-Antworten zu aktivieren.
Ausführliche Werkzeugzusammenfassungen werden beim Werkzeugstart ausgegeben (kein Debounce); die Control-UI
streamt Werkzeugausgaben über Agent-Events, sofern verfügbar.
Weitere Details: [Streaming + chunking](/concepts/streaming).

## Modell-Referenzen

Modell-Referenzen in der Konfiguration (zum Beispiel `agents.defaults.model` und `agents.defaults.models`) werden geparst, indem beim **ersten** `/` getrennt wird.

- Verwenden Sie `provider/model` beim Konfigurieren von Modellen.
- Wenn die Modell-ID selbst `/` enthält (OpenRouter-Stil), schließen Sie das Anbieterpräfix ein (Beispiel: `openrouter/moonshotai/kimi-k2`).
- Wenn Sie den Anbieter weglassen, behandelt OpenClaw die Eingabe als Alias oder als Modell für den **Standardanbieter** (funktioniert nur, wenn es kein `/` in der Modell-ID gibt).

## Konfiguration (minimal)

Mindestens zu setzen:

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom` (dringend empfohlen)

---

_Next: [Group Chats](/channels/group-messages)_ 🦞
