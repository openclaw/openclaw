---
summary: "OpenClaw가 macOS 앱에서 Apple 디바이스 모델 식별자를 사용하여 사용자 친화적인 이름을 제공하는 방법."
read_when:
  - 디바이스 모델 식별자 매핑 또는 NOTICE/라이선스 파일 업데이트 시
  - 인스턴스 UI에서 디바이스 이름 표시 방법 변경 시
title: "디바이스 모델 데이터베이스"
---

# 디바이스 모델 데이터베이스 (친숙한 이름)

macOS 동반 앱은 Apple 모델 식별자(e.g. `iPad16,6`, `Mac16,6`)를 사용자 친화적인 이름으로 매핑하여 **인스턴스** UI에 표시합니다.

이 매핑은 다음 위치에서 JSON 형식으로 제공됩니다:

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## 데이터 소스

우리는 현재 MIT 라이선스가 적용된 리포지토리에서 매핑을 가져오고 있습니다:

- `kyle-seongwoo-jun/apple-device-identifiers`

빌드를 결정론적으로 유지하기 위해, JSON 파일은 특정 업스트림 커밋에 고정됩니다 (`apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`에 기록).

## 데이터베이스 업데이트

1. 고정하고자 하는 업스트림 커밋을 선택합니다 (iOS 하나, macOS 하나).
2. `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`에서 커밋 해시를 업데이트합니다.
3. 해당 커밋에 고정된 JSON 파일을 다시 다운로드합니다:

```bash
IOS_COMMIT="<ios-device-identifiers.json에 대한 커밋 sha>"
MAC_COMMIT="<mac-device-identifiers.json에 대한 커밋 sha>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt`가 여전히 업스트림과 일치하는지 확인합니다 (업스트림 라이선스가 변경되면 교체).
5. macOS 앱이 경고 없이 깨끗하게 빌드되는지 검증합니다:

```bash
swift build --package-path apps/macos
```
