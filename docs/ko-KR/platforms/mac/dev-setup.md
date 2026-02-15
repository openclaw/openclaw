---
summary: "Setup guide for developers working on the OpenClaw macOS app"
read_when:
  - Setting up the macOS development environment
title: "macOS Dev Setup"
x-i18n:
  source_hash: 52d3cadae980ae622898724cabc9bf2c383de7f6c01f59d1b42ebe93264a336e
---

# macOS 개발자 설정

이 가이드에서는 소스에서 OpenClaw macOS 애플리케이션을 빌드하고 실행하는 데 필요한 단계를 다룹니다.

## 전제조건

앱을 빌드하기 전에 다음이 설치되어 있는지 확인하세요.

1. **Xcode 26.2+**: Swift 개발에 필요합니다.
2. **Node.js 22+ & pnpm**: 게이트웨이, CLI 및 패키징 스크립트에 필요합니다.

## 1. 종속성 설치

프로젝트 전체 종속성을 설치합니다.

```bash
pnpm install
```

## 2. 앱 빌드 및 패키징

macOS 앱을 빌드하고 `dist/OpenClaw.app`로 패키징하려면 다음을 실행하세요.

```bash
./scripts/package-mac-app.sh
```

Apple 개발자 ID 인증서가 없으면 스크립트는 자동으로 **임시 서명**(`-`)을 사용합니다.

개발 실행 모드, 서명 플래그 및 팀 ID 문제 해결에 대해서는 macOS 앱 추가 정보를 참조하세요.
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **참고**: 임시 서명된 앱은 보안 메시지를 트리거할 수 있습니다. 앱이 "Abort Trap 6"과 함께 즉시 충돌하는 경우 [문제 해결](#troubleshooting) 섹션을 참조하세요.

## 3. CLI 설치

macOS 앱에서는 백그라운드 작업을 관리하기 위해 전역 `openclaw` CLI 설치가 필요합니다.

**설치 방법(권장):**

1. OpenClaw 앱을 엽니다.
2. **일반** 설정 탭으로 이동합니다.
3. **"CLI 설치"**를 클릭합니다.

또는 수동으로 설치하십시오.

```bash
npm install -g openclaw@<version>
```

## 문제 해결

### 빌드 실패: 도구 체인 또는 SDK 불일치

macOS 앱 빌드에는 최신 macOS SDK 및 Swift 6.2 도구 체인이 필요합니다.

**시스템 종속성(필수):**

- **소프트웨어 업데이트에서 사용 가능한 최신 macOS 버전**(Xcode 26.2 SDK에 필요)
- **Xcode 26.2** (Swift 6.2 툴체인)

**검사:**

```bash
xcodebuild -version
xcrun swift --version
```

버전이 일치하지 않으면 macOS/Xcode를 업데이트하고 빌드를 다시 실행하세요.

### 권한 부여 시 앱 충돌

**음성 인식** 또는 **마이크** 액세스를 허용하려고 할 때 앱이 충돌하는 경우 TCC 캐시가 손상되었거나 서명 불일치가 원인일 수 있습니다.

**수정:**

1. TCC 권한을 재설정합니다.

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. 실패할 경우 [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh)에서 `BUNDLE_ID`를 일시적으로 변경하여 macOS에서 "깨끗한 상태"를 강제 적용합니다.

### 게이트웨이 "시작 중..." 무기한

게이트웨이 상태가 "시작 중..."으로 유지되면 좀비 프로세스가 포트를 보유하고 있는지 확인하십시오.

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

수동 실행으로 인해 포트가 보류 중인 경우 해당 프로세스를 중지합니다(Ctrl+C). 최후의 수단으로 위에서 찾은 PID를 종료하십시오.
