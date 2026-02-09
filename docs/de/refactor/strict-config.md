---
summary: "„Strikte Konfigurationsvalidierung + ausschließlich Doctor-Migrationen“"
read_when:
  - Entwurf oder Implementierung von Verhalten zur Konfigurationsvalidierung
  - Arbeit an Konfigurationsmigrationen oder Doctor-Workflows
  - Umgang mit Plugin-Konfigurationsschemata oder dem Gating beim Plugin-Laden
title: "„Strikte Konfigurationsvalidierung“"
---

# Strikte Konfigurationsvalidierung (Doctor-only-Migrationen)

## Ziele

- **Unbekannte Konfigurationsschlüssel überall ablehnen** (Root + verschachtelt).
- **Plugin-Konfiguration ohne Schema ablehnen**; dieses Plugin nicht laden.
- **Legacy-Auto-Migration beim Laden entfernen**; Migrationen laufen ausschließlich über Doctor.
- **Doctor beim Start automatisch ausführen (Dry-Run)**; bei Ungültigkeit nicht-diagnostische Befehle blockieren.

## Nicht-Ziele

- Abwärtskompatibilität beim Laden (Legacy-Schlüssel werden nicht automatisch migriert).
- Stilles Verwerfen nicht erkannter Schlüssel.

## Regeln für strikte Validierung

- Die Konfiguration muss auf jeder Ebene exakt dem Schema entsprechen.
- Unbekannte Schlüssel sind Validierungsfehler (kein Passthrough auf Root- oder verschachtelter Ebene).
- `plugins.entries.<id>.config` muss durch das Schema des Plugins validiert werden.
  - Fehlt einem Plugin ein Schema, **Plugin-Laden ablehnen** und einen klaren Fehler anzeigen.
- Unbekannte `channels.<id>`-Schlüssel sind Fehler, es sei denn, ein Plugin-Manifest deklariert die Kanal-ID.
- Plugin-Manifeste (`openclaw.plugin.json`) sind für alle Plugins erforderlich.

## Durchsetzung von Plugin-Schemata

- Jedes Plugin stellt ein striktes JSON-Schema für seine Konfiguration bereit (inline im Manifest).
- Ablauf beim Laden von Plugins:
  1. Plugin-Manifest + Schema auflösen (`openclaw.plugin.json`).
  2. Konfiguration gegen das Schema validieren.
  3. Bei fehlendem Schema oder ungültiger Konfiguration: Plugin-Laden blockieren, Fehler protokollieren.
- Die Fehlermeldung enthält:
  - Plugin-ID
  - Grund (fehlendes Schema / ungültige Konfiguration)
  - Pfad(e), bei denen die Validierung fehlgeschlagen ist
- Deaktivierte Plugins behalten ihre Konfiguration, aber Doctor + Logs geben eine Warnung aus.

## Doctor-Ablauf

- Doctor wird **bei jedem** Laden der Konfiguration ausgeführt (standardmäßig als Dry-Run).
- Wenn die Konfiguration ungültig ist:
  - Zusammenfassung + umsetzbare Fehler ausgeben.
  - Anweisung: `openclaw doctor --fix`.
- `openclaw doctor --fix`:
  - Wendet Migrationen an.
  - Entfernt unbekannte Schlüssel.
  - Schreibt die aktualisierte Konfiguration.

## Befehls-Gating (wenn die Konfiguration ungültig ist)

Erlaubt (nur Diagnose):

- `openclaw doctor`
- `openclaw logs`
- `openclaw health`
- `openclaw help`
- `openclaw status`
- `openclaw gateway status`

Alles andere muss hart fehlschlagen mit: „Konfiguration ungültig. Führen Sie `openclaw doctor --fix` aus.“

## Fehler-UX-Format

- Eine einzelne Überschriften-Zusammenfassung.
- Gruppierte Abschnitte:
  - Unbekannte Schlüssel (vollständige Pfade)
  - Legacy-Schlüssel / erforderliche Migrationen
  - Fehler beim Plugin-Laden (Plugin-ID + Grund + Pfad)

## Implementierungs-Touchpoints

- `src/config/zod-schema.ts`: Root-Passthrough entfernen; überall strikte Objekte.
- `src/config/zod-schema.providers.ts`: strikte Kanal-Schemata sicherstellen.
- `src/config/validation.ts`: bei unbekannten Schlüsseln fehlschlagen; keine Legacy-Migrationen anwenden.
- `src/config/io.ts`: Legacy-Auto-Migrationen entfernen; Doctor immer als Dry-Run ausführen.
- `src/config/legacy*.ts`: Nutzung ausschließlich auf Doctor verlagern.
- `src/plugins/*`: Schema-Registry + Gating hinzufügen.
- CLI-Befehls-Gating in `src/cli`.

## Tests

- Ablehnung unbekannter Schlüssel (Root + verschachtelt).
- Plugin ohne Schema → Plugin-Laden mit klarem Fehler blockiert.
- Ungültige Konfiguration → Gateway-Start blockiert, außer Diagnosebefehle.
- Doctor-Dry-Run automatisch; `doctor --fix` schreibt korrigierte Konfiguration.
