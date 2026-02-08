---
summary: "Hvordan OpenClaw leverer Apple-enhedsmodelidentifikatorer med brugervenlige navne i macOS-appen."
read_when:
  - Opdatering af tilknytninger for enhedsmodelidentifikatorer eller NOTICE-/licensfiler
  - Ændring af, hvordan Instances UI viser enhedsnavne
title: "Enhedsmodel-database"
x-i18n:
  source_path: reference/device-models.md
  source_hash: 1d99c2538a0d8fdd
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:37Z
---

# Enhedsmodel-database (brugervenlige navne)

macOS Companion-app’en viser brugervenlige Apple-enhedsmodelnavne i **Instances** UI ved at mappe Apple-modelidentifikatorer (f.eks. `iPad16,6`, `Mac16,6`) til menneskeligt læsbare navne.

Mappingen medleveres som JSON under:

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## Datakilde

Vi medleverer i øjeblikket mappingen fra det MIT-licenserede repository:

- `kyle-seongwoo-jun/apple-device-identifiers`

For at holde builds deterministiske er JSON-filerne fastlåst til specifikke upstream-commits (registreret i `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`).

## Opdatering af databasen

1. Vælg de upstream-commits, du vil fastlåse til (én for iOS, én for macOS).
2. Opdater commit-hashene i `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`.
3. Download JSON-filerne igen, fastlåst til disse commits:

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. Sørg for, at `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` stadig matcher upstream (udskift den, hvis upstream-licensen ændrer sig).
5. Verificér, at macOS-appen bygger uden fejl (ingen advarsler):

```bash
swift build --package-path apps/macos
```
