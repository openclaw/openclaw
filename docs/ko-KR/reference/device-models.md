---
summary: "How OpenClaw vendors Apple device model identifiers for friendly names in the macOS app."
read_when:
  - Updating device model identifier mappings or NOTICE/license files
  - Changing how Instances UI displays device names
title: "Device Model Database"
x-i18n:
  source_hash: 1d99c2538a0d8fdd80fa468fa402f63479ef2522e83745a0a46527a86238aeb2
---

# 장치 모델 데이터베이스(친숙한 이름)

macOS 컴패니언 앱은 Apple 모델 식별자(예: `iPad16,6`, `Mac16,6`)를 사람이 읽을 수 있는 이름에 매핑하여 **인스턴스** UI에 친숙한 Apple 장치 모델 이름을 표시합니다.

매핑은 다음에서 JSON으로 공급됩니다.

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## 데이터 소스

현재 우리는 MIT 라이선스 저장소에서 매핑을 공급하고 있습니다.

- `kyle-seongwoo-jun/apple-device-identifiers`

빌드 결정성을 유지하기 위해 JSON 파일은 특정 업스트림 커밋(`apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`에 기록됨)에 고정됩니다.

## 데이터베이스 업데이트 중

1. 고정하려는 업스트림 커밋을 선택합니다(iOS용 하나, macOS용 하나).
2. `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`에서 커밋 해시를 업데이트합니다.
3. 해당 커밋에 고정된 JSON 파일을 다시 다운로드합니다.

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt`가 여전히 업스트림과 일치하는지 확인합니다(업스트림 라이선스가 변경되면 교체).
5. macOS 앱이 깔끔하게 빌드되었는지 확인합니다(경고 없음).

```bash
swift build --package-path apps/macos
```
