---
summary: "Wie OpenClaw Apple-Gerätemodellkennungen für benutzerfreundliche Namen in der macOS-App bereitstellt."
read_when:
  - Aktualisieren der Zuordnungen von Gerätemodellkennungen oder der NOTICE-/Lizenzdateien
  - Ändern der Darstellung von Gerätenamen in der Instances-UI
title: "Gerätemodell-Datenbank"
---

# Gerätemodell-Datenbank (benutzerfreundliche Namen)

Die macOS-Companion-App zeigt benutzerfreundliche Apple-Gerätemodellnamen in der **Instances**-UI an, indem sie Apple-Modellkennungen (z. B. `iPad16,6`, `Mac16,6`) auf menschenlesbare Namen abbildet.

Die Zuordnung wird als JSON unter folgendem Pfad bereitgestellt:

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## Datenquelle

Derzeit beziehen wir die Zuordnung aus dem unter der MIT-Lizenz stehenden Repository:

- `kyle-seongwoo-jun/apple-device-identifiers`

Um deterministische Builds zu gewährleisten, sind die JSON-Dateien auf bestimmte Upstream-Commits fixiert (vermerkt in `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`).

## Aktualisieren der Datenbank

1. Wählen Sie die Upstream-Commits aus, auf die Sie fixieren möchten (einen für iOS, einen für macOS).
2. Aktualisieren Sie die Commit-Hashes in `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`.
3. Laden Sie die JSON-Dateien erneut herunter, fixiert auf diese Commits:

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. Stellen Sie sicher, dass `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` weiterhin dem Upstream entspricht (ersetzen Sie die Datei, falls sich die Upstream-Lizenz ändert).
5. Verifizieren Sie, dass die macOS-App sauber baut (keine Warnungen):

```bash
swift build --package-path apps/macos
```
