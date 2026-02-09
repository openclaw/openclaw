---
summary: "„Was der OpenClaw-System-Prompt enthält und wie er zusammengestellt wird“"
read_when:
  - Beim Bearbeiten des System-Prompt-Texts, der Werkzeugliste oder der Zeit-/Heartbeat-Abschnitte
  - Beim Ändern des Workspace-Bootstraps oder des Verhaltens der Skills-Injektion
title: "„System-Prompt“"
---

# System-Prompt

OpenClaw erstellt für jeden Agentenlauf einen benutzerdefinierten System-Prompt. Der Prompt ist **OpenClaw-eigen** und verwendet nicht den Standard-Prompt von p-coding-agent.

Der Prompt wird von OpenClaw zusammengestellt und in jeden Agentenlauf injiziert.

## Struktur

Der Prompt ist bewusst kompakt und verwendet feste Abschnitte:

- **Tooling**: aktuelle Werkzeugliste + kurze Beschreibungen.
- **Safety**: kurze Guardrail-Erinnerung, um machtorientiertes Verhalten oder das Umgehen von Aufsicht zu vermeiden.
- **Skills** (wenn verfügbar): erklärt dem Modell, wie Skill-Anweisungen bei Bedarf geladen werden.
- **OpenClaw Self-Update**: wie `config.apply` und `update.run` ausgeführt werden.
- **Workspace**: Arbeitsverzeichnis (`agents.defaults.workspace`).
- **Documentation**: lokaler Pfad zu den OpenClaw-Dokumenten (Repo oder npm-Paket) und wann sie zu lesen sind.
- **Workspace Files (injected)**: weist darauf hin, dass Bootstrap-Dateien unten enthalten sind.
- **Sandbox** (wenn aktiviert): weist auf die sandboxed Laufzeit, Sandbox-Pfade und darauf hin, ob erhöhte Exec-Rechte verfügbar sind.
- **Current Date & Time**: benutzerlokale Zeit, Zeitzone und Zeitformat.
- **Reply Tags**: optionale Reply-Tag-Syntax für unterstützte Anbieter.
- **Heartbeats**: Heartbeat-Prompt und Ack-Verhalten.
- **Runtime**: Host, OS, Node, Modell, Repo-Root (wenn erkannt), Denkebene (eine Zeile).
- **Reasoning**: aktuelle Sichtbarkeitsebene + Hinweis zum /reasoning-Toggle.

Safety-Guardrails im System-Prompt sind beratend. Sie leiten das Modellverhalten, setzen jedoch keine Richtlinien durch. Verwenden Sie Tool-Richtlinien, Exec-Freigaben, sandboxing und Kanal-Allowlists für harte Durchsetzung; Betreiber können diese bewusst deaktivieren.

## Prompt-Modi

OpenClaw kann kleinere System-Prompts für Sub-Agenten rendern. Die Laufzeit setzt pro Lauf ein
`promptMode` (keine benutzerseitige Konfiguration):

- `full` (Standard): enthält alle oben genannten Abschnitte.
- `minimal`: wird für Sub-Agenten verwendet; lässt **Skills**, **Memory Recall**, **OpenClaw
  Self-Update**, **Model Aliases**, **User Identity**, **Reply Tags**,
  **Messaging**, **Silent Replies** und **Heartbeats** weg. Tooling, **Safety**,
  Workspace, Sandbox, Current Date & Time (wenn bekannt), Runtime und injizierter
  Kontext bleiben verfügbar.
- `none`: gibt nur die Basis-Identitätszeile zurück.

Wenn `promptMode=minimal`, werden zusätzlich injizierte Prompts als **Subagent
Context** statt **Group Chat Context** gekennzeichnet.

## Workspace-Bootstrap-Injektion

Bootstrap-Dateien werden gekürzt und unter **Project Context** angehängt, sodass das Modell Identitäts- und Profilkontext sieht, ohne explizite Lesevorgänge zu benötigen:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (nur bei brandneuen Workspaces)

Große Dateien werden mit einem Marker gekürzt. Die maximale Größe pro Datei wird durch
`agents.defaults.bootstrapMaxChars` (Standard: 20000) gesteuert. Fehlende Dateien injizieren einen
kurzen Marker für fehlende Dateien.

Interne Hooks können diesen Schritt über `agent:bootstrap` abfangen, um die injizierten Bootstrap-Dateien zu verändern oder zu ersetzen (z. B. durch Austauschen von `SOUL.md` gegen eine alternative Persona).

Um zu prüfen, wie viel jede injizierte Datei beiträgt (roh vs. injiziert, Kürzung sowie Tool-Schema-Overhead), verwenden Sie `/context list` oder `/context detail`. Siehe [Context](/concepts/context).

## Zeitverarbeitung

Der System-Prompt enthält einen dedizierten Abschnitt **Current Date & Time**, wenn die Benutzerzeitzone bekannt ist. Um den Prompt cache-stabil zu halten, enthält er nun nur noch die **Zeitzone** (keine dynamische Uhr oder Zeitformat).

Verwenden Sie `session_status`, wenn der Agent die aktuelle Zeit benötigt; die Statuskarte
enthält eine Zeitstempelzeile.

Konfiguration über:

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

Siehe [Date & Time](/date-time) für vollständige Details zum Verhalten.

## Skills

Wenn geeignete Skills existieren, injiziert OpenClaw eine kompakte **Liste verfügbarer Skills**
(`formatSkillsForPrompt`), die für jeden Skill den **Dateipfad** enthält. Der
Prompt weist das Modell an, `read` zu verwenden, um die SKILL.md am angegebenen
Ort zu laden (Workspace, verwaltet oder gebündelt). Wenn keine Skills geeignet sind, wird der
Skills-Abschnitt weggelassen.

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

Dies hält den Basis-Prompt klein und ermöglicht dennoch gezielte Skill-Nutzung.

## Documentation

Wenn verfügbar, enthält der System-Prompt einen Abschnitt **Documentation**, der auf das
lokale OpenClaw-Dokumentationsverzeichnis verweist (entweder `docs/` im Repo-Workspace oder die gebündelten npm-
Paket-Dokumente) und außerdem den öffentlichen Mirror, das Source-Repo, den Community-Discord und
ClawHub ([https://clawhub.com](https://clawhub.com)) für die Skill-Discovery nennt. Der Prompt weist das Modell an, lokale Dokumente zuerst zu konsultieren
für OpenClaw-Verhalten, Befehle, Konfiguration oder Architektur und, wenn möglich, `openclaw status` selbst auszuführen (den Benutzer nur zu fragen, wenn kein Zugriff besteht).
