---
read_when:
    - macOS 개발 환경 설정
summary: OpenClaw macOS 앱 작업을 수행하는 개발자를 위한 설정 가이드
title: macOS 개발 설정
x-i18n:
    generated_at: "2026-02-08T16:04:13Z"
    model: gtx
    provider: google-translate
    source_hash: 52d3cadae980ae622898724cabc9bf2c383de7f6c01f59d1b42ebe93264a336e
    source_path: platforms/mac/dev-setup.md
    workflow: 15
---

# macOS 개발자 설정

이 가이드에서는 소스에서 OpenClaw macOS 애플리케이션을 빌드하고 실행하는 데 필요한 단계를 다룹니다.

## 전제조건

앱을 빌드하기 전에 다음이 설치되어 있는지 확인하세요.

1. **Xcode 26.2+**: Swift 개발에 필요합니다.
2. **Node.js 22+ 및 pnpm**: 게이트웨이, CLI 및 패키징 스크립트에 필요합니다.

## 1. 종속성 설치

프로젝트 전체 종속성을 설치합니다.

```bash
pnpm install
```

## 2. 앱 빌드 및 패키징

macOS 앱을 빌드하고 패키징하려면 `dist/OpenClaw.app`, 달리다:

```bash
./scripts/package-mac-app.sh
```

Apple 개발자 ID 인증서가 없으면 스크립트는 자동으로 다음을 사용합니다. **임시 서명** (`-`).

개발 실행 모드, 서명 플래그 및 팀 ID 문제 해결에 대해서는 macOS 앱 추가 정보를 참조하세요.
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **메모**: 임시 서명된 앱은 보안 프롬프트를 트리거할 수 있습니다. 앱이 "Abort Trap 6"과 함께 즉시 충돌하는 경우 다음을 참조하세요. [문제 해결](#troubleshooting) 부분.

## 3. CLI 설치

macOS 앱은 글로벌을 기대합니다. `openclaw` 백그라운드 작업을 관리하기 위해 CLI를 설치합니다.

**설치하려면(권장):**

1. OpenClaw 앱을 엽니다.
2. 로 이동 **일반적인** 설정 탭.
3. 딸깍 하는 소리 **"CLI 설치"**.

또는 수동으로 설치하십시오.

```bash
npm install -g openclaw@<version>
```

## 문제 해결

### 빌드 실패: 도구 체인 또는 SDK 불일치

macOS 앱 빌드에는 최신 macOS SDK 및 Swift 6.2 도구 체인이 필요합니다.

**시스템 종속성(필수):**

- **소프트웨어 업데이트에서 사용 가능한 최신 macOS 버전** (Xcode 26.2 SDK에 필요)
- **엑스코드 26.2** (Swift 6.2 툴체인)

**체크 무늬:**

```bash
xcodebuild -version
xcrun swift --version
```

버전이 일치하지 않으면 macOS/Xcode를 업데이트하고 빌드를 다시 실행하세요.

### 권한 부여 시 앱 충돌

허용하려고 할 때 앱이 충돌하는 경우 **음성 인식** 또는 **마이크로폰** 액세스할 수 없는 경우 TCC 캐시가 손상되었거나 서명 불일치가 원인일 수 있습니다.

**고치다:**

1. TCC 권한을 재설정합니다.

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. 실패하면 `BUNDLE_ID` 일시적으로 [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) macOS에서 "깨끗한 슬레이트"를 강제로 실행합니다.

### 게이트웨이 "시작 중..." 무기한

게이트웨이 상태가 "시작 중..."으로 유지되면 좀비 프로세스가 포트를 보유하고 있는지 확인하십시오.

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

수동 실행으로 인해 포트가 보류 중인 경우 해당 프로세스를 중지합니다(Ctrl+C). 최후의 수단으로 위에서 찾은 PID를 종료하십시오.
