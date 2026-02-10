---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "How OpenClaw vendors Apple device model identifiers for friendly names in the macOS app."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Updating device model identifier mappings or NOTICE/license files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing how Instances UI displays device names（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Device Model Database"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Device model database (friendly names)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The macOS companion app shows friendly Apple device model names in the **Instances** UI by mapping Apple model identifiers (e.g. `iPad16,6`, `Mac16,6`) to human-readable names.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The mapping is vendored as JSON under:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Data source（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
We currently vendor the mapping from the MIT-licensed repository:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `kyle-seongwoo-jun/apple-device-identifiers`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To keep builds deterministic, the JSON files are pinned to specific upstream commits (recorded in `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Updating the database（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Pick the upstream commits you want to pin to (one for iOS, one for macOS).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Update the commit hashes in `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Re-download the JSON files, pinned to those commits:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Ensure `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` still matches upstream (replace it if the upstream license changes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Verify the macOS app builds cleanly (no warnings):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
swift build --package-path apps/macos（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
