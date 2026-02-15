---
summary: "Gateway runtime on macOS (external launchd service)"
read_when:
  - Packaging OpenClaw.app
  - Debugging the macOS gateway launchd service
  - Installing the gateway CLI for macOS
title: "Gateway on macOS"
x-i18n:
  source_hash: 4a3e963d13060b123538005439213e786e76127b370a6c834d85a369e4626fe5
---

# macOS의 게이트웨이(외부 실행)

OpenClaw.app은 더 이상 Node/Bun 또는 게이트웨이 런타임을 번들로 제공하지 않습니다. macOS 앱
**외부** `openclaw` CLI 설치를 예상하며 게이트웨이를
하위 프로세스를 관리하고 사용자별 실행 서비스를 관리하여 게이트웨이를 유지합니다.
실행 중입니다(또는 이미 실행 중인 경우 기존 로컬 게이트웨이에 연결).

## CLI 설치(로컬 모드에 필요)

Mac에 Node 22 이상이 필요하고 `openclaw`를 전역적으로 설치하십시오.

```bash
npm install -g openclaw@<version>
```

macOS 앱의 **Install CLI** 버튼은 npm/pnpm을 통해 동일한 흐름을 실행합니다(Gateway 런타임에는 권장되지 않음).

## Launchd(LaunchAgent로서의 게이트웨이)

라벨:

- `bot.molt.gateway` (또는 `bot.molt.<profile>`; 레거시 `com.openclaw.*`가 남아 있을 수 있음)

Plist 위치(사용자별):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (또는 `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

관리자:

- macOS 앱은 로컬 모드에서 LaunchAgent 설치/업데이트를 소유합니다.
- CLI에서도 설치할 수 있습니다: `openclaw gateway install`.

행동:

- "OpenClaw Active"는 LaunchAgent를 활성화/비활성화합니다.
- 앱 종료는 게이트웨이를 중지하지 **않습니다**(launchd는 게이트웨이를 활성 상태로 유지합니다).
- 구성된 포트에서 게이트웨이가 이미 실행되고 있는 경우 앱은 다음에 연결됩니다.
  새로운 것을 시작하는 대신에.

로깅:

- stdout/err 실행: `/tmp/openclaw/openclaw-gateway.log`

## 버전 호환성

macOS 앱은 자체 버전과 비교하여 게이트웨이 버전을 확인합니다. 만일 그들이
호환되지 않습니다. 앱 버전과 일치하도록 전역 CLI를 업데이트하세요.

## 스모크체크

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

그런 다음:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
