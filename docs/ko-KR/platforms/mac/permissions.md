---
summary: "macOS 권한 유지 (TCC) 및 서명 요구 사항"
read_when:
  - 누락되거나 고정된 macOS 권한 프롬프트를 디버깅할 때
  - macOS 앱을 패키징하거나 서명할 때
  - 번들 ID 또는 앱 설치 경로를 변경할 때
title: "macOS 권한"
x-i18n:
  source_path: docs/platforms/mac/permissions.md
---

# macOS 권한 (TCC)

macOS 권한 부여는 취약합니다. TCC 는 앱의 코드 서명, 번들 식별자, 디스크 경로와
권한 부여를 연결합니다. 이 중 하나라도 변경되면, macOS 는 앱을 새 것으로 취급하고
프롬프트를 삭제하거나 숨길 수 있습니다.

## 안정적인 권한을 위한 요구 사항

- 동일한 경로: 고정된 위치에서 앱을 실행합니다 (OpenClaw 의 경우, `dist/OpenClaw.app`).
- 동일한 번들 식별자: 번들 ID 를 변경하면 새 권한 아이덴티티가 생성됩니다.
- 서명된 앱: 서명되지 않거나 ad-hoc 서명된 빌드는 권한을 유지하지 않습니다.
- 일관된 서명: 실제 Apple Development 또는 Developer ID 인증서를 사용하여
  서명이 재빌드 간 안정적으로 유지되도록 합니다.

Ad-hoc 서명은 매 빌드마다 새 아이덴티티를 생성합니다. macOS 가 이전 부여를 잊어버리고,
오래된 항목이 지워질 때까지 프롬프트가 완전히 사라질 수 있습니다.

## 프롬프트가 사라질 때 복구 체크리스트

1. 앱을 종료합니다.
2. 시스템 설정 -> 개인 정보 보호 및 보안에서 앱 항목을 제거합니다.
3. 동일한 경로에서 앱을 다시 실행하고 권한을 다시 부여합니다.
4. 프롬프트가 여전히 나타나지 않으면 `tccutil` 로 TCC 항목을 초기화하고 다시 시도합니다.
5. 일부 권한은 macOS 를 완전히 재시작한 후에만 다시 나타납니다.

초기화 예시 (필요에 따라 번들 ID 교체):

```bash
sudo tccutil reset Accessibility ai.openclaw.mac
sudo tccutil reset ScreenCapture ai.openclaw.mac
sudo tccutil reset AppleEvents
```

## 파일 및 폴더 권한 (데스크톱/문서/다운로드)

macOS 는 터미널/백그라운드 프로세스에 대해 데스크톱, 문서, 다운로드를 제한할 수도 있습니다. 파일 읽기 또는 디렉토리 목록이 멈추면, 파일 작업을 수행하는 동일한 프로세스 컨텍스트에 접근을 부여하세요 (예: Terminal/iTerm, LaunchAgent 에서 실행된 앱, 또는 SSH 프로세스).

해결 방법: 폴더별 부여를 피하려면 파일을 OpenClaw 작업 공간 (`~/.openclaw/workspace`) 으로 이동하세요.

권한을 테스트하는 경우 항상 실제 인증서로 서명하세요. Ad-hoc
빌드는 권한이 중요하지 않은 빠른 로컬 실행에만 허용됩니다.
