---
summary: "Hoe OpenClaw Apple-apparaatmodelidentifiers levert voor gebruiksvriendelijke namen in de macOS-app."
read_when:
  - Bijwerken van toewijzingen van apparaatmodelidentifiers of NOTICE-/licentiebestanden
  - Wijzigen van hoe de Instances-UI apparaatnamen weergeeft
title: "Apparaatmodeldatabase"
x-i18n:
  source_path: reference/device-models.md
  source_hash: 1d99c2538a0d8fdd
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:39Z
---

# Apparaatmodeldatabase (gebruiksvriendelijke namen)

De macOS Companion-app toont gebruiksvriendelijke Apple-apparaatmodelnamen in de **Instances**-UI door Apple-modelidentifiers (bijv. `iPad16,6`, `Mac16,6`) te koppelen aan voor mensen leesbare namen.

De toewijzing wordt als JSON meegeleverd onder:

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## Databron

We leveren de toewijzing momenteel mee vanuit de MIT-gelicentieerde repository:

- `kyle-seongwoo-jun/apple-device-identifiers`

Om builds deterministisch te houden, zijn de JSON-bestanden vastgepind op specifieke upstream-commits (vastgelegd in `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`).

## De database bijwerken

1. Kies de upstream-commits waarop je wilt vastpinnen (één voor iOS, één voor macOS).
2. Werk de commit-hashes bij in `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`.
3. Download de JSON-bestanden opnieuw, vastgepind op die commits:

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. Zorg ervoor dat `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` nog steeds overeenkomt met upstream (vervang het als de upstream-licentie verandert).
5. Verifieer dat de macOS-app zonder problemen bouwt (geen waarschuwingen):

```bash
swift build --package-path apps/macos
```
