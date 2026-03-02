---
summary: "macOS의 Gateway 런타임 (외부 launchd 서비스)"
read_when:
  - OpenClaw.app을 패키징할 때
  - macOS gateway launchd 서비스를 디버깅할 때
  - macOS용 gateway CLI를 설치할 때
title: "macOS의 Gateway"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/platforms/mac/bundled-gateway.md"
  workflow: 15
---

# macOS의 Gateway (외부 launchd)

OpenClaw.app은 더 이상 Node/Bun이나 Gateway 런타임을 번들로 포함하지 않습니다. macOS 앱은 **외부** `openclaw` CLI 설치를 예상하며, Gateway를 자식 프로세스로 생성하지 않고, Gateway를 실행 상태로 유지하기 위해 사용자별 launchd 서비스를 관리합니다 (또는 이미 실행 중인 로컬 Gateway가 있으면 기존 Gateway에 연결합니다).

## CLI 설치 (로컬 모드에 필수)

Mac에 Node 22+이 필요하며, `openclaw`를 전역으로 설치합니다:

```bash
npm install -g openclaw@<version>
```

macOS 앱의 **Install CLI** 버튼은 npm/pnpm을 통해 동일한 흐름을 실행합니다 (Gateway 런타임에는 bun을 권장하지 않음).

## Launchd (Gateway를 LaunchAgent로 실행)

레이블:

- `ai.openclaw.gateway` (또는 `ai.openclaw.<profile>`; 레거시 `com.openclaw.*`는 유지될 수 있음)

Plist 위치 (사용자별):

- `~/Library/LaunchAgents/ai.openclaw.gateway.plist`
  (또는 `~/Library/LaunchAgents/ai.openclaw.<profile>.plist`)

관리자:

- macOS 앱은 로컬 모드에서 LaunchAgent 설치/업데이트를 담당합니다.
- CLI도 설치할 수 있습니다: `openclaw gateway install`.

동작:

- "OpenClaw Active"는 LaunchAgent를 활성화/비활성화합니다.
- 앱을 종료해도 gateway는 멈추지 않습니다 (launchd가 실행 상태를 유지함).
- 구성된 포트에서 Gateway가 이미 실행 중이면, 앱은 새로운 gateway를 시작하는 대신 기존 gateway에 연결됩니다.

로깅:

- launchd stdout/err: `/tmp/openclaw/openclaw-gateway.log`

## 버전 호환성

macOS 앱은 gateway 버전을 자신의 버전과 비교합니다. 호환되지 않으면 전역 CLI를 앱 버전과 일치하도록 업데이트합니다.

## 스모크 테스트

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

그 다음:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
