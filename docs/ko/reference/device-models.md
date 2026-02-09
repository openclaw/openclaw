---
summary: "OpenClaw 가 macOS 앱에서 친숙한 이름을 표시하기 위해 Apple 디바이스 모델 식별자를 어떻게 벤더링하는지 설명합니다."
read_when:
  - 디바이스 모델 식별자 매핑 또는 NOTICE/라이선스 파일을 업데이트할 때
  - Instances UI 가 디바이스 이름을 표시하는 방식을 변경할 때
title: "디바이스 모델 데이터베이스"
---

# 디바이스 모델 데이터베이스 (친숙한 이름)

macOS 컴패니언 앱은 Apple 모델 식별자(예: `iPad16,6`, `Mac16,6`)를 사람이 읽기 쉬운 이름으로 매핑하여 **Instances** UI 에서 친숙한 Apple 디바이스 모델 이름을 표시합니다.

이 매핑은 다음 경로 아래에 JSON 으로 벤더링됩니다:

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## 데이터 소스

현재 우리는 MIT 라이선스 저장소에서 이 매핑을 벤더링합니다:

- `kyle-seongwoo-jun/apple-device-identifiers`

빌드를 결정적으로 유지하기 위해, JSON 파일은 특정 업스트림 커밋에 고정되어 있습니다(`apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md` 에 기록됨).

## 데이터베이스 업데이트

1. 고정할 업스트림 커밋을 선택합니다(iOS 용 하나, macOS 용 하나).
2. `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md` 에서 커밋 해시를 업데이트합니다.
3. 해당 커밋에 고정된 JSON 파일을 다시 다운로드합니다:

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` 가 여전히 업스트림과 일치하는지 확인합니다(업스트림 라이선스가 변경되면 교체하십시오).
5. macOS 앱이 경고 없이 정상적으로 빌드되는지 확인합니다:

```bash
swift build --package-path apps/macos
```
