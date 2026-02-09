---
summary: "macOS에서의 Gateway(게이트웨이) 런타임 (외부 launchd 서비스)"
read_when:
  - OpenClaw.app 패키징
  - macOS Gateway(게이트웨이) launchd 서비스 디버깅
  - macOS용 Gateway(게이트웨이) CLI 설치
title: "macOS의 Gateway(게이트웨이)"
---

# macOS의 Gateway(게이트웨이) (외부 launchd)

OpenClaw.app에는 더 이상 Node/Bun 또는 Gateway(게이트웨이) 런타임이 번들로 포함되지 않습니다. macOS 앱은 **외부** `openclaw` CLI 설치를 기대하며, Gateway(게이트웨이)를 자식 프로세스로 생성하지 않고, Gateway(게이트웨이)를 계속 실행 상태로 유지하기 위해 사용자별 launchd 서비스를 관리합니다(이미 로컬에서 Gateway(게이트웨이)가 실행 중인 경우에는 해당 인스턴스에 연결합니다).

## CLI 설치 (로컬 모드에 필수)

Mac에 Node 22+가 필요하며, 이후 `openclaw`를 전역으로 설치합니다:

```bash
npm install -g openclaw@<version>
```

macOS 앱의 **Install CLI** 버튼은 npm/pnpm을 통해 동일한 흐름을 실행합니다(Gateway(게이트웨이) 런타임에는 bun을 권장하지 않습니다).

## Launchd (LaunchAgent로서의 Gateway)

Label:

- `bot.molt.gateway` (또는 `bot.molt.<profile>`; 레거시 `com.openclaw.*`가 남아 있을 수 있음)

Plist 위치(사용자별):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (또는 `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

Manager:

- macOS 앱은 로컬 모드에서 LaunchAgent 설치/업데이트를 소유합니다.
- CLI를 통해서도 설치할 수 있습니다: `openclaw gateway install`.

동작:

- “OpenClaw Active”는 LaunchAgent를 활성화/비활성화합니다.
- 앱을 종료해도 Gateway(게이트웨이)는 중지되지 않습니다(launchd가 실행 상태를 유지).
- 구성된 포트에서 Gateway(게이트웨이)가 이미 실행 중인 경우, 새로 시작하지 않고 해당 인스턴스에 연결합니다.

로깅:

- launchd stdout/err: `/tmp/openclaw/openclaw-gateway.log`

## 버전 호환성

macOS 앱은 Gateway(게이트웨이) 버전을 자체 버전과 비교합니다. 호환되지 않는 경우, 앱 버전에 맞게 전역 CLI를 업데이트하십시오.

## 스모크 체크

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

그다음:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
