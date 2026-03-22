---
summary: "macOS 에서의 Gateway 런타임 (외부 launchd 서비스)"
read_when:
  - OpenClaw.app 을 패키징할 때
  - macOS Gateway launchd 서비스를 디버깅할 때
  - macOS 용 Gateway CLI 를 설치할 때
title: "macOS 의 Gateway"
x-i18n:
  source_path: docs/platforms/mac/bundled-gateway.md
---

# macOS 의 Gateway (외부 launchd)

OpenClaw.app 은 더 이상 Node/Bun 또는 Gateway 런타임을 번들하지 않습니다. macOS 앱은
**외부** `openclaw` CLI 설치를 기대하고, Gateway 를 자식 프로세스로 생성하지 않으며,
Gateway 를 계속 실행하기 위해 사용자별 launchd 서비스를 관리합니다
(또는 이미 실행 중인 로컬 Gateway 가 있으면 연결합니다).

## CLI 설치 (로컬 모드에 필요)

Node 24 가 Mac 의 기본 런타임입니다. Node 22 LTS, 현재 `22.16+`, 호환성을 위해 여전히 작동합니다. 그런 다음 `openclaw` 을 전역으로 설치합니다:

```bash
npm install -g openclaw@<version>
```

macOS 앱의 **CLI 설치** 버튼은 npm/pnpm 을 통해 동일한 흐름을 실행합니다 (bun 은 Gateway 런타임에 권장되지 않음).

## Launchd (LaunchAgent 로서의 Gateway)

레이블:

- `ai.openclaw.gateway` (또는 `ai.openclaw.<profile>`; 레거시 `com.openclaw.*` 가 남아있을 수 있음)

Plist 위치 (사용자별):

- `~/Library/LaunchAgents/ai.openclaw.gateway.plist`
  (또는 `~/Library/LaunchAgents/ai.openclaw.<profile>.plist`)

관리자:

- macOS 앱이 로컬 모드에서 LaunchAgent 설치/업데이트를 소유합니다.
- CLI 도 설치할 수 있습니다: `openclaw gateway install`.

동작:

- "OpenClaw 활성" 이 LaunchAgent 를 활성화/비활성화합니다.
- 앱 종료가 Gateway 를 중지하지 **않습니다** (launchd 가 유지).
- 설정된 포트에서 Gateway 가 이미 실행 중이면, 앱은 새 것을 시작하는 대신
  연결합니다.

로깅:

- launchd stdout/err: `/tmp/openclaw/openclaw-gateway.log`

## 버전 호환성

macOS 앱은 Gateway 버전을 자체 버전과 비교합니다. 호환되지 않으면
글로벌 CLI 를 앱 버전에 맞게 업데이트하세요.

## 스모크 체크

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
