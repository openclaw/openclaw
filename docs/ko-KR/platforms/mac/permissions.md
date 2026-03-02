---
summary: "macOS 권한 지속성 (TCC) 및 서명 요구 사항"
read_when:
  - 누락되었거나 고착된 macOS 권한 프롬프트를 디버깅할 때
  - macOS 앱을 패키징하거나 서명할 때
  - 번들 ID 또는 앱 설치 경로를 변경할 때
title: "macOS 권한"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/platforms/mac/permissions.md"
  workflow: 15
---

# macOS 권한 (TCC)

macOS 권한 부여는 취약합니다. TCC는 권한 부여를 앱의 코드 서명, 번들 식별자, 그리고 디스크상의 경로와 연결합니다. 이 중 하나가 변경되면, macOS는 앱을 새 것으로 취급하고 프롬프트를 삭제하거나 숨길 수 있습니다.

## 안정적인 권한을 위한 요구 사항

- 동일한 경로: 고정된 위치에서 앱을 실행합니다 (OpenClaw의 경우 `dist/OpenClaw.app`).
- 동일한 번들 식별자: 번들 ID를 변경하면 새 권한 항등성이 생성됩니다.
- 서명된 앱: 서명되지 않거나 ad-hoc 서명 빌드는 권한을 유지하지 않습니다.
- 일관된 서명: 실제 Apple Development 또는 Developer ID 인증서를 사용하므로 재빌드 간에 서명이 안정적으로 유지됩니다.

Ad-hoc 서명은 각 빌드마다 새 항등성을 생성합니다. macOS는 이전 부여를 잊어버리며, 오래된 항목이 지워질 때까지 프롬프트가 사라질 수 있습니다.

## 프롬프트가 사라질 때 복구 체크리스트

1. 앱을 종료합니다.
2. System Settings -> Privacy & Security에서 앱 항목을 제거합니다.
3. 동일한 경로에서 앱을 다시 시작하고 권한을 다시 부여합니다.
4. 프롬프트가 여전히 나타나지 않으면, `tccutil`로 TCC 항목을 재설정하고 다시 시도합니다.
5. 일부 권한은 전체 macOS 재시작 후에만 다시 나타납니다.

예제 재설정 (필요에 따라 번들 ID 바꾸기):

```bash
sudo tccutil reset Accessibility ai.openclaw.mac
sudo tccutil reset ScreenCapture ai.openclaw.mac
sudo tccutil reset AppleEvents
```

## 파일 및 폴더 권한 (Desktop/Documents/Downloads)

macOS는 또한 터미널/백그라운드 프로세스에 대해 Desktop, Documents, 그리고 Downloads를 제어할 수 있습니다. 파일 읽기 또는 디렉토리 목록이 행을 때, 파일 작업을 수행하는 동일한 프로세스 컨텍스트에 접근을 부여합니다 (예: Terminal/iTerm, LaunchAgent-시작 앱, 또는 SSH 프로세스).

해결 방법: OpenClaw 워크스페이스 (`~/.openclaw/workspace`)로 파일을 이동합니다. 폴더별 부여를 피하려고 할 경우입니다.

권한을 테스트한다면, 항상 실제 인증서로 서명합니다. Ad-hoc
빌드는 권한이 중요하지 않은 빠른 로컬 실행에만 허용됩니다.
