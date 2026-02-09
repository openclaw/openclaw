---
summary: "Hur OpenClaw levererar Apple-enhetsmodellidentifierare som lättlästa namn i macOS-appen."
read_when:
  - Uppdaterar mappningar för enhetsmodellidentifierare eller NOTICE/licensfiler
  - Ändrar hur Instances-gränssnittet visar enhetsnamn
title: "Databas för enhetsmodeller"
---

# Databas för enhetsmodeller (lättlästa namn)

MacOS följeslagare app visar vänliga Apple-enhetsmodellnamn i **Instanser** UI genom att mappa Apple-modell-identifierare (t.ex. `iPad16,6`, `Mac16,6`) till människoläsbara namn.

Mappningen levereras som JSON under:

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## Datakälla

Vi levererar för närvarande mappningen från det MIT-licensierade arkivet:

- `kyle-seongwoo-jun/apple-device-identifiers`

För att hålla byggen deterministiska är JSON-filerna låsta till specifika upstream-commits (registrerade i `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`).

## Uppdatera databasen

1. Välj de upstream-commits du vill låsa till (en för iOS, en för macOS).
2. Uppdatera commit-hasharna i `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`.
3. Ladda ner JSON-filerna igen, låsta till dessa commits:

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. Säkerställ att `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` fortfarande matchar upstream (ersätt den om upstream-licensen ändras).
5. Verifiera att macOS-appen bygger utan varningar:

```bash
swift build --package-path apps/macos
```
