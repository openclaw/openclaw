---
summary: "Hur OpenClaw levererar Apple-enhetsmodellidentifierare som lättlästa namn i macOS-appen."
read_when:
  - Uppdaterar mappningar för enhetsmodellidentifierare eller NOTICE/licensfiler
  - Ändrar hur Instances-gränssnittet visar enhetsnamn
title: "Databas för enhetsmodeller"
x-i18n:
  source_path: reference/device-models.md
  source_hash: 1d99c2538a0d8fdd
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:18Z
---

# Databas för enhetsmodeller (lättlästa namn)

macOS companion-appen visar lättlästa Apple-enhetsmodellnamn i **Instances**-gränssnittet genom att mappa Apple-modellidentifierare (t.ex. `iPad16,6`, `Mac16,6`) till namn som är begripliga för människor.

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
