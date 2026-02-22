---
summary: "OpenClaw macOS 앱에서 작업하는 개발자를 위한 설정 가이드"
read_when:
  - macOS 개발 환경 설정
title: "macOS 개발 설정"
---

# macOS 개발자 설정

이 가이드는 OpenClaw macOS 애플리케이션을 소스에서 빌드하고 실행하는 데 필요한 단계에 대해 설명합니다.

## 사전 준비 사항

앱을 빌드하기 전에 다음을 설치했는지 확인하세요:

1. **Xcode 26.2+**: Swift 개발에 필요합니다.
2. **Node.js 22+ & pnpm**: 게이트웨이, CLI, 패키징 스크립트에 필요합니다.

## 1. 의존성 설치

프로젝트 전반의 의존성을 설치합니다:

```bash
pnpm install
```

## 2. 앱 빌드 및 패키징

macOS 앱을 빌드하고 `dist/OpenClaw.app`에 패키징하려면 다음을 실행하세요:

```bash
./scripts/package-mac-app.sh
```

Apple Developer ID 인증서가 없는 경우, 스크립트는 자동으로 **ad-hoc 서명** (`-`)을 사용합니다.

개발 실행 모드, 서명 플래그 및 팀 ID 문제 해결에 대한 자세한 내용은 macOS 앱 README를 참조하세요: [https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **주의**: ad-hoc 서명된 앱은 보안 프롬프트를 트리거할 수 있습니다. 앱이 즉시 "Abort trap 6"으로 충돌하면, [문제 해결](#troubleshooting) 섹션을 참조하세요.

## 3. CLI 설치

macOS 앱은 백그라운드 작업을 관리하기 위해 전역 `openclaw` CLI 설치를 기대합니다.

**설치 방법 (권장):**

1. OpenClaw 앱을 엽니다.
2. **일반** 설정 탭으로 이동하세요.
3. **"CLI 설치"**를 클릭하세요.

또는 수동으로 설치하세요:

```bash
npm install -g openclaw@<version>
```

## 문제 해결

### 빌드 실패: 도구 체인 또는 SDK 불일치

macOS 앱 빌드는 최신 macOS SDK 및 Swift 6.2 도구 체인을 기대합니다.

**시스템 의존성 (필수):**

- **소프트웨어 업데이트에서 사용할 수 있는 최신 macOS 버전** (Xcode 26.2 SDK에 필요)
- **Xcode 26.2** (Swift 6.2 도구 체인)

**확인:**

```bash
xcodebuild -version
xcrun swift --version
```

버전이 일치하지 않으면, macOS/Xcode를 업데이트하고 빌드를 다시 실행하세요.

### 권한 부여 시 앱 충돌

**Speech Recognition** 또는 **Microphone** 접근을 허용하려고 할 때 앱이 충돌하면, 손상된 TCC 캐시 또는 서명 불일치 때문일 수 있습니다.

**수정 방법:**

1. TCC 권한을 재설정하세요:

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. 실패할 경우, 강제로 macOS에서 "클린 슬레이트"를 만들기 위해 [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh)의 `BUNDLE_ID`를 일시적으로 변경하세요.

### 게이트웨이 "시작 중..." 무한

게이트웨이 상태가 "시작 중..."으로 계속 유지되면 포트를 점유하는 좀비 프로세스가 있는지 확인하세요:

```bash
openclaw gateway status
openclaw gateway stop

# LaunchAgent를 사용하지 않는 경우 (개발 모드/수동 실행), 리스너를 찾으세요:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

수동 실행이 포트를 점유하고 있다면 그 프로세스를 중지하세요 (Ctrl+C). 최후의 수단으로, 앞에서 찾은 PID를 종료하세요.