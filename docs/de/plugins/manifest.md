---
summary: "Plugin-Manifest + JSON-Schema-Anforderungen (strikte Konfigurationsvalidierung)"
read_when:
  - Sie entwickeln ein OpenClaw-Plugin
  - Sie müssen ein Plugin-Konfigurationsschema ausliefern oder Fehler bei der Plugin-Validierung debuggen
title: "Plugin-Manifest"
---

# Plugin-Manifest (openclaw.plugin.json)

Jedes Plugin **muss** eine `openclaw.plugin.json`-Datei im **Plugin-Root** ausliefern.
OpenClaw verwendet dieses Manifest, um die Konfiguration zu validieren, **ohne Plugin-Code auszuführen**. Fehlende oder ungültige Manifeste werden als Plugin-Fehler behandelt und blockieren
die Konfigurationsvalidierung.

Siehe den vollständigen Leitfaden zum Plugin-System: [Plugins](/tools/plugin).

## Erforderliche Felder

```json
{
  "id": "voice-call",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

Erforderliche Schlüssel:

- `id` (string): kanonische Plugin-ID.
- `configSchema` (object): JSON-Schema für die Plugin-Konfiguration (inline).

Optionale Schlüssel:

- `kind` (string): Plugin-Typ (Beispiel: `"memory"`).
- `channels` (array): von diesem Plugin registrierte Kanal-IDs (Beispiel: `["matrix"]`).
- `providers` (array): von diesem Plugin registrierte Anbieter-IDs.
- `skills` (array): zu ladende Skill-Verzeichnisse (relativ zum Plugin-Root).
- `name` (string): Anzeigename des Plugins.
- `description` (string): kurze Plugin-Zusammenfassung.
- `uiHints` (object): Bezeichnungen/Platzhalter/Sensitivitäts-Flags für Konfigurationsfelder zur UI-Darstellung.
- `version` (string): Plugin-Version (informativ).

## JSON-Schema-Anforderungen

- **Jedes Plugin muss ein JSON-Schema ausliefern**, auch wenn es keine Konfiguration akzeptiert.
- Ein leeres Schema ist zulässig (zum Beispiel `{ "type": "object", "additionalProperties": false }`).
- Schemata werden beim Lesen/Schreiben der Konfiguration validiert, nicht zur Laufzeit.

## Validierungsverhalten

- Unbekannte `channels.*`-Schlüssel sind **Fehler**, sofern die Kanal-ID nicht durch
  ein Plugin-Manifest deklariert ist.
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny` und `plugins.slots.*`
  müssen auf **auffindbare** Plugin-IDs verweisen. Unbekannte IDs sind **Fehler**.
- Ist ein Plugin installiert, hat aber ein defektes oder fehlendes Manifest oder Schema,
  schlägt die Validierung fehl und Doctor meldet den Plugin-Fehler.
- Existiert eine Plugin-Konfiguration, ist das Plugin jedoch **deaktiviert**, wird die
  Konfiguration beibehalten und in Doctor + Logs eine **Warnung** angezeigt.

## Hinweise

- Das Manifest ist **für alle Plugins erforderlich**, einschließlich lokaler Dateisystem-Ladevorgänge.
- Die Laufzeit lädt das Plugin-Modul weiterhin separat; das Manifest dient nur der
  Discovery (Erkennung) + Validierung.
- Wenn Ihr Plugin von nativen Modulen abhängt, dokumentieren Sie die Build-Schritte
  sowie etwaige Allowlist-Anforderungen des Paketmanagers (zum Beispiel pnpm `allow-build-scripts`
  - `pnpm rebuild <package>`).
