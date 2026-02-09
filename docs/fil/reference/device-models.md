---
summary: "Kung paano kino-vendor ng OpenClaw ang mga Apple device model identifier bilang mga friendly name sa macOS app."
read_when:
  - Ina-update ang mga mapping ng device model identifier o mga NOTICE/license file
  - Binabago kung paano ipinapakita ng Instances UI ang mga pangalan ng device
title: "Database ng Device Model"
---

# Database ng device model (mga friendly name)

Ipinapakita ng macOS companion app ang mga friendly na pangalan ng Apple device model sa **Instances** UI sa pamamagitan ng pagma-map ng mga Apple model identifier (hal. `iPad16,6`, `Mac16,6`) sa mga pangalang madaling basahin ng tao.

Ang mapping ay kino-vendor bilang JSON sa ilalim ng:

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## Pinagmulan ng data

Sa kasalukuyan, kino-vendor namin ang mapping mula sa repository na may MIT license:

- `kyle-seongwoo-jun/apple-device-identifiers`

Upang panatilihing deterministic ang mga build, ang mga JSON file ay naka-pin sa mga partikular na upstream commit (naitatala sa `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`).

## Pag-update ng database

1. Piliin ang mga upstream commit na gusto mong i-pin (isa para sa iOS, isa para sa macOS).
2. I-update ang mga commit hash sa `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`.
3. I-download muli ang mga JSON file, naka-pin sa mga commit na iyon:

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. Tiyaking tumutugma pa rin ang `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` sa upstream (palitan ito kung nagbago ang upstream license).
5. I-verify na malinis na nagbu-build ang macOS app (walang mga babala):

```bash
swift build --package-path apps/macos
```
