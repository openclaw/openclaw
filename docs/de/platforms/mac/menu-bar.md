---
summary: "„Logik des Menüleistenstatus und was Benutzern angezeigt wird“"
read_when:
  - Optimierung der macOS-Menü-UI oder der Statuslogik
title: "„Menüleiste“"
---

# Logik des Menüleistenstatus

## Was angezeigt wird

- Wir zeigen den aktuellen Arbeitsstatus des Agenten im Menüleistensymbol und in der ersten Statuszeile des Menüs an.
- Der Gesundheitsstatus wird ausgeblendet, während Arbeit aktiv ist; er erscheint wieder, wenn alle Sitzungen inaktiv sind.
- Der Block „Nodes“ im Menü listet **nur Geräte** (gekoppelte Nodes über `node.list`), keine Client-/Presence-Einträge.
- Ein Abschnitt „Usage“ erscheint unter „Context“, wenn Usage-Snapshots des Anbieters verfügbar sind.

## Zustandsmodell

- Sitzungen: Ereignisse treffen mit `runId` (pro Lauf) sowie `sessionKey` im Payload ein. Die „Haupt“-Sitzung ist der Schlüssel `main`; falls nicht vorhanden, greifen wir auf die zuletzt aktualisierte Sitzung zurück.
- Priorität: Die Hauptsitzung gewinnt immer. Ist die Hauptsitzung aktiv, wird ihr Zustand sofort angezeigt. Ist die Hauptsitzung inaktiv, wird die zuletzt aktive Nicht‑Hauptsitzung angezeigt. Wir wechseln nicht während einer Aktivität hin und her; ein Wechsel erfolgt nur, wenn die aktuelle Sitzung inaktiv wird oder die Hauptsitzung aktiv wird.
- Aktivitätsarten:
  - `job`: Ausführung von Befehlen auf hoher Ebene (`state: started|streaming|done|error`).
  - `tool`: `phase: start|result` mit `toolName` und `meta/args`.

## IconState-Enum (Swift)

- `idle`
- `workingMain(ActivityKind)`
- `workingOther(ActivityKind)`
- `overridden(ActivityKind)` (Debug-Override)

### ActivityKind → Glyph

- `exec` → 💻
- `read` → 📄
- `write` → ✍️
- `edit` → 📝
- `attach` → 📎
- Standard → 🛠️

### Visuelles Mapping

- `idle`: normales Critter.
- `workingMain`: Badge mit Glyph, volle Tönung, „arbeitende“ Beinanimation.
- `workingOther`: Badge mit Glyph, gedämpfte Tönung, kein Huschen.
- `overridden`: verwendet das gewählte Glyph/die gewählte Tönung unabhängig von der Aktivität.

## Text der Statuszeile (Menü)

- Während Arbeit aktiv ist: `<Session role> · <activity label>`
  - Beispiele: `Main · exec: pnpm test`, `Other · read: apps/macos/Sources/OpenClaw/AppState.swift`.
- Im Leerlauf: fällt auf die Gesundheitszusammenfassung zurück.

## Ereignisaufnahme

- Quelle: Control-Channel-`agent`-Ereignisse (`ControlChannel.handleAgentEvent`).
- Geparste Felder:
  - `stream: "job"` mit `data.state` für Start/Stopp.
  - `stream: "tool"` mit `data.phase`, `name`, optional `meta`/`args`.
- Beschriftungen:
  - `exec`: erste Zeile von `args.command`.
  - `read`/`write`: verkürzter Pfad.
  - `edit`: Pfad plus abgeleitete Änderungsart aus `meta`/Diff-Zählungen.
  - Fallback: Werkzeugname.

## Debug-Override

- Einstellungen ▸ Debug ▸ Auswahl „Icon override“:
  - `System (auto)` (Standard)
  - `Working: main` (pro Werkzeugart)
  - `Working: other` (pro Werkzeugart)
  - `Idle`
- Gespeichert über `@AppStorage("iconOverride")`; zugeordnet zu `IconState.overridden`.

## Test-Checkliste

- Job der Hauptsitzung auslösen: prüfen, dass das Symbol sofort wechselt und die Statuszeile das Hauptlabel anzeigt.
- Job einer Nicht‑Hauptsitzung auslösen, während die Hauptsitzung inaktiv ist: Symbol/Status zeigen die Nicht‑Hauptsitzung; bleibt stabil, bis sie beendet ist.
- Hauptsitzung starten, während eine andere aktiv ist: Symbol wechselt sofort zur Hauptsitzung.
- Schnelle Werkzeug-Bursts: sicherstellen, dass das Badge nicht flackert (TTL‑Schonfrist bei Werkzeugergebnissen).
- Die Gesundheitszeile erscheint wieder, sobald alle Sitzungen inaktiv sind.
