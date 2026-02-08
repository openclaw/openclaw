---
read_when:
    - 누락되거나 중단된 macOS 권한 프롬프트 디버깅
    - macOS 앱 패키징 또는 서명
    - 번들 ID 또는 앱 설치 경로 변경
summary: macOS 권한 지속성(TCC) 및 서명 요구 사항
title: macOS 권한
x-i18n:
    generated_at: "2026-02-08T16:07:20Z"
    model: gtx
    provider: google-translate
    source_hash: 52bee5c896e31e9966bc9eb7e8e43eb18a674117e7e1bf6d83c4acaf9a83613f
    source_path: platforms/mac/permissions.md
    workflow: 15
---

# macOS 권한(TCC)

macOS 권한 부여는 취약합니다. TCC는 권한 부여를
앱의 코드 서명, 번들 식별자, 디스크상의 경로. 그 중 하나라도 변경되면
macOS는 해당 앱을 새로운 앱으로 취급하며 프롬프트를 삭제하거나 숨길 수 있습니다.

## 안정적인 권한 요구 사항

- 동일 경로: 고정된 위치에서 앱 실행(OpenClaw의 경우, `dist/OpenClaw.app`).
- 동일한 번들 식별자: 번들 ID를 변경하면 새로운 권한 ID가 생성됩니다.
- 서명된 앱: 서명되지 않았거나 임시로 서명된 빌드는 권한을 유지하지 않습니다.
- 일관된 서명: 실제 Apple 개발 또는 개발자 ID 인증서 사용
  따라서 재구축 시에도 서명이 안정적으로 유지됩니다.

임시 서명은 빌드마다 새로운 ID를 생성합니다. macOS는 이전 항목을 잊어버립니다
오래된 항목이 지워질 때까지 승인 및 프롬프트가 완전히 사라질 수 있습니다.

## 프롬프트가 사라질 때의 복구 체크리스트

1. 앱을 종료하세요.
2. 시스템 설정 -> 개인 정보 보호 및 보안에서 앱 항목을 제거하세요.
3. 동일한 경로에서 앱을 다시 실행하고 권한을 다시 부여하세요.
4. 프롬프트가 여전히 나타나지 않으면 다음을 사용하여 TCC 항목을 재설정하십시오. `tccutil` 그리고 다시 시도해 보세요.
5. 일부 권한은 macOS를 완전히 다시 시작한 후에만 다시 나타납니다.

재설정 예(필요에 따라 번들 ID 교체):

```bash
sudo tccutil reset Accessibility bot.molt.mac
sudo tccutil reset ScreenCapture bot.molt.mac
sudo tccutil reset AppleEvents
```

## 파일 및 폴더 권한(데스크톱/문서/다운로드)

macOS는 터미널/백그라운드 프로세스를 위해 데스크탑, 문서 및 다운로드를 제어할 수도 있습니다. 파일 읽기 또는 디렉터리 목록이 중단되면 파일 작업을 수행하는 동일한 프로세스 컨텍스트(예: 터미널/iTerm, LaunchAgent 실행 앱 또는 SSH 프로세스)에 대한 액세스 권한을 부여하세요.

해결 방법: 파일을 OpenClaw 작업 공간(`~/.openclaw/workspace`) 폴더별 부여를 피하려는 경우.

권한을 테스트하는 경우 항상 실제 인증서로 서명하세요. 임시
빌드는 권한이 중요하지 않은 빠른 로컬 실행에만 허용됩니다.
