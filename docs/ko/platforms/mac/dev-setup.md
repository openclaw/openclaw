---
summary: "OpenClaw macOS 앱에서 작업하는 개발자를 위한 설정 가이드"
read_when:
  - macOS 개발 환경 설정
title: "macOS 개발자 설정"
---

# macOS 개발자 설정

이 가이드는 OpenClaw macOS 애플리케이션을 소스에서 빌드하고 실행하는 데 필요한 단계를 설명합니다.

## 사전 요구 사항

앱을 빌드하기 전에 다음 항목이 설치되어 있는지 확인하십시오:

1. **Xcode 26.2+**: Swift 개발에 필요합니다.
2. **Node.js 22+ 및 pnpm**: Gateway(게이트웨이), CLI, 패키징 스크립트에 필요합니다.

## 1) 의존성 설치

프로젝트 전반의 의존성을 설치합니다:

```bash
pnpm install
```

## 2. 앱 빌드 및 패키징

macOS 앱을 빌드하고 `dist/OpenClaw.app` 으로 패키징하려면 다음을 실행하십시오:

```bash
./scripts/package-mac-app.sh
```

Apple Developer ID 인증서가 없는 경우, 스크립트는 자동으로 **ad-hoc 서명**(`-`)을 사용합니다.

개발 실행 모드, 서명 플래그, Team ID 문제 해결에 대해서는 macOS 앱 README 를 참고하십시오:
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **참고**: Ad-hoc 서명된 앱은 보안 경고를 표시할 수 있습니다. 앱이 "Abort trap 6" 과 함께 즉시 크래시되는 경우, [문제 해결](#troubleshooting) 섹션을 참고하십시오.

## 3. CLI 설치

macOS 앱은 백그라운드 작업을 관리하기 위해 전역 `openclaw` CLI 설치를 기대합니다.

**설치 방법 (권장):**

1. OpenClaw 앱을 엽니다.
2. **General** 설정 탭으로 이동합니다.
3. **"Install CLI"** 를 클릭합니다.

또는 수동으로 설치할 수 있습니다:

```bash
npm install -g openclaw@<version>
```

## 문제 해결

### 빌드 실패: 툴체인 또는 SDK 불일치

macOS 앱 빌드는 최신 macOS SDK 와 Swift 6.2 툴체인을 기대합니다.

**시스템 의존성 (필수):**

- **Software Update 에서 제공되는 최신 macOS 버전** (Xcode 26.2 SDK 에 필요)
- **Xcode 26.2** (Swift 6.2 툴체인)

**확인 방법:**

```bash
xcodebuild -version
xcrun swift --version
```

버전이 일치하지 않는 경우 macOS/Xcode 를 업데이트한 후 빌드를 다시 실행하십시오.

### 27. 권한 부여 시 앱 충돌

**음성 인식** 또는 **마이크** 접근을 허용하려 할 때 앱이 크래시된다면, 손상된 TCC 캐시 또는 서명 불일치가 원인일 수 있습니다.

**해결 방법:**

1. TCC 권한을 초기화합니다:

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. 그래도 해결되지 않으면, macOS 에서 "초기 상태"를 강제하기 위해 [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) 에서 `BUNDLE_ID` 을 일시적으로 변경하십시오.

### Gateway "Starting..."

Gateway 상태가 "Starting..." 에서 멈춰 있는 경우, 좀비 프로세스가 포트를 점유하고 있는지 확인하십시오:

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

수동 실행이 포트를 점유하고 있다면 해당 프로세스를 중지하십시오(Ctrl+C). 최후의 수단으로 위에서 찾은 PID 를 종료하십시오.
