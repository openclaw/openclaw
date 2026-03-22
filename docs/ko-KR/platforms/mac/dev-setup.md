---
summary: "OpenClaw macOS 앱을 작업하는 개발자를 위한 설정 가이드"
read_when:
  - macOS 개발 환경을 설정할 때
title: "macOS 개발 설정"
x-i18n:
  source_path: docs/platforms/mac/dev-setup.md
---

# macOS 개발자 설정

이 가이드는 소스에서 OpenClaw macOS 애플리케이션을 빌드하고 실행하기 위한 필요한 단계를 다룹니다.

## 사전 요구 사항

앱을 빌드하기 전에 다음이 설치되어 있는지 확인하세요:

1. **Xcode 26.2+**: Swift 개발에 필요합니다.
2. **Node.js 24 & pnpm**: Gateway, CLI, 패키징 스크립트에 권장됩니다. Node 22 LTS, 현재 `22.16+`, 호환성을 위해 여전히 지원됩니다.

## 1. 의존성 설치

프로젝트 전체 의존성을 설치합니다:

```bash
pnpm install
```

## 2. 앱 빌드 및 패키징

macOS 앱을 빌드하고 `dist/OpenClaw.app` 으로 패키징하려면 실행하세요:

```bash
./scripts/package-mac-app.sh
```

Apple Developer ID 인증서가 없는 경우, 스크립트가 자동으로 **ad-hoc 서명** (`-`) 을 사용합니다.

개발 실행 모드, 서명 플래그, Team ID 문제 해결은 macOS 앱 README 를 참조하세요:
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **참고**: Ad-hoc 서명된 앱은 보안 프롬프트를 트리거할 수 있습니다. 앱이 "Abort trap 6" 으로 즉시 충돌하면, [문제 해결](#문제-해결) 섹션을 참조하세요.

## 3. CLI 설치

macOS 앱은 백그라운드 작업을 관리하기 위해 글로벌 `openclaw` CLI 설치를 기대합니다.

**설치하려면 (권장):**

1. OpenClaw 앱을 엽니다.
2. **일반** 설정 탭으로 이동합니다.
3. **"CLI 설치"** 를 클릭합니다.

또는 수동으로 설치합니다:

```bash
npm install -g openclaw@<version>
```

## 문제 해결

### 빌드 실패: 툴체인 또는 SDK 불일치

macOS 앱 빌드는 최신 macOS SDK 와 Swift 6.2 툴체인을 기대합니다.

**시스템 의존성 (필수):**

- **소프트웨어 업데이트에서 사용 가능한 최신 macOS 버전** (Xcode 26.2 SDK 에 필요)
- **Xcode 26.2** (Swift 6.2 툴체인)

**확인:**

```bash
xcodebuild -version
xcrun swift --version
```

버전이 일치하지 않으면 macOS/Xcode 를 업데이트하고 빌드를 다시 실행하세요.

### 권한 부여 시 앱 충돌

**음성 인식** 또는 **마이크** 접근을 허용하려고 할 때 앱이 충돌하면, 손상된 TCC 캐시 또는 서명 불일치 때문일 수 있습니다.

**수정:**

1. TCC 권한을 초기화합니다:

   ```bash
   tccutil reset All ai.openclaw.mac.debug
   ```

2. 그래도 실패하면, [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) 에서 `BUNDLE_ID` 를 일시적으로 변경하여 macOS 에서 "깨끗한 상태" 를 강제합니다.

### Gateway "시작 중..." 무한 대기

Gateway 상태가 "시작 중..." 에 머무르면, 좀비 프로세스가 포트를 점유하고 있는지 확인하세요:

```bash
openclaw gateway status
openclaw gateway stop

# LaunchAgent 를 사용하지 않는 경우 (개발 모드 / 수동 실행), 리스너를 찾습니다:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

수동 실행이 포트를 점유하고 있다면, 해당 프로세스를 중지하세요 (Ctrl+C). 최후의 수단으로 위에서 찾은 PID 를 종료하세요.
