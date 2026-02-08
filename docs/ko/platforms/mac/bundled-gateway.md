---
read_when:
    - OpenClaw.app 패키징
    - macOS 게이트웨이 실행 서비스 디버깅
    - macOS용 게이트웨이 CLI 설치
summary: macOS의 게이트웨이 런타임(외부 실행 서비스)
title: macOS의 게이트웨이
x-i18n:
    generated_at: "2026-02-08T16:08:00Z"
    model: gtx
    provider: google-translate
    source_hash: 4a3e963d13060b123538005439213e786e76127b370a6c834d85a369e4626fe5
    source_path: platforms/mac/bundled-gateway.md
    workflow: 15
---

# macOS의 게이트웨이(외부 실행)

OpenClaw.app은 더 이상 Node/Bun 또는 게이트웨이 런타임을 번들로 제공하지 않습니다. macOS 앱
기대한다 **외부** `openclaw` CLI 설치는 게이트웨이를 다음으로 생성하지 않습니다.
하위 프로세스를 관리하고 사용자별 실행 서비스를 관리하여 게이트웨이를 유지합니다.
실행 중입니다(또는 이미 실행 중인 경우 기존 로컬 게이트웨이에 연결).

## CLI 설치(로컬 모드에 필요)

Mac에 Node 22+가 필요하고 설치하세요. `openclaw` 전 세계적으로:

```bash
npm install -g openclaw@<version>
```

macOS 앱의 **CLI 설치** 버튼은 npm/pnpm을 통해 동일한 흐름을 실행합니다(Gateway 런타임에는 권장되지 않음).

## Launchd(LaunchAgent로서의 게이트웨이)

상표:

- `bot.molt.gateway` (또는 `bot.molt.<profile>`; 유산 `com.openclaw.*` 남을 수도 있음)

Plist 위치(사용자별):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
   (또는 `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

관리자:

- macOS 앱은 로컬 모드에서 LaunchAgent 설치/업데이트를 소유합니다.
- CLI를 사용하여 설치할 수도 있습니다. `openclaw gateway install`.

행동:

- "OpenClaw Active"는 LaunchAgent를 활성화/비활성화합니다.
- 앱 종료는 **~ 아니다** 게이트웨이를 중지합니다(launchd는 게이트웨이를 활성 상태로 유지합니다).
- 구성된 포트에서 게이트웨이가 이미 실행되고 있는 경우 앱은 다음에 연결됩니다.
  새로운 것을 시작하는 대신에.

벌채 반출:

- stdout/err 실행: `/tmp/openclaw/openclaw-gateway.log`

## 버전 호환성

macOS 앱은 자체 버전과 비교하여 게이트웨이 버전을 확인합니다. 만일 그들이
호환되지 않습니다. 앱 버전과 일치하도록 전역 CLI를 업데이트하세요.

## 연기 점검

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

그 다음에:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
