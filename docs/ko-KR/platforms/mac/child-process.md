---
summary: "macOS의 Gateway 라이프사이클 (launchd)"
read_when:
  - mac 앱을 gateway 라이프사이클과 통합할 때
title: "Gateway 라이프사이클"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/platforms/mac/child-process.md"
  workflow: 15
---

# macOS의 Gateway 라이프사이클

macOS 앱은 **기본적으로 launchd를 통해 Gateway를 관리**하며, Gateway를 자식 프로세스로 생성하지 않습니다. 먼저 구성된 포트의 이미 실행 중인 Gateway에 연결을 시도합니다. 도달 가능한 것이 없으면, 외부 `openclaw` CLI를 통해 launchd 서비스를 활성화합니다 (임베드된 런타임 없음). 이것은 로그인 시 신뢰할 수 있는 자동 시작과 충돌 시 재시작을 제공합니다.

자식 프로세스 모드 (app에서 직접 생성된 Gateway)는 **현재 사용되지 않습니다**. UI와의 더 밀접한 결합이 필요하면 터미널에서 Gateway를 수동으로 실행합니다.

## 기본 동작 (launchd)

- 앱은 사용자별 LaunchAgent를 설치합니다. 레이블은 `ai.openclaw.gateway`입니다
  (`--profile`/`OPENCLAW_PROFILE` 사용 시 `ai.openclaw.<profile>`. 레거시 `com.openclaw.*` 지원됨).
- 로컬 모드가 활성화되면, 앱은 LaunchAgent가 로드되도록 보장하고
  필요할 경우 Gateway를 시작합니다.
- 로그는 launchd gateway 로그 경로에 기록됩니다 (Debug Settings에서 표시됨).

일반 명령어:

```bash
launchctl kickstart -k gui/$UID/ai.openclaw.gateway
launchctl bootout gui/$UID/ai.openclaw.gateway
```

명명된 프로필을 실행할 때 레이블을 `ai.openclaw.<profile>`로 바꿉니다.

## 서명되지 않은 개발 빌드

`scripts/restart-mac.sh --no-sign`은 서명 키가 없을 때 빠른 로컬 빌드용입니다. launchd가 서명되지 않은 릴레이 바이너리를 가리키는 것을 방지하려면:

- `~/.openclaw/disable-launchagent`를 작성합니다.

서명된 `scripts/restart-mac.sh` 실행은 마커가 있으면 이 재정의를 지웁니다. 수동으로 재설정하려면:

```bash
rm ~/.openclaw/disable-launchagent
```

## 연결 전용 모드

macOS 앱이 **절대 launchd를 설치하거나 관리하지 않도록** 강제하려면, `--attach-only` (또는 `--no-launchd`)로 실행합니다. 이것은 `~/.openclaw/disable-launchagent`를 설정하므로, 앱은 이미 실행 중인 Gateway에만 연결합니다. Debug Settings에서 동일한 동작을 전환할 수 있습니다.

## 원격 모드

원격 모드는 절대 로컬 Gateway를 시작하지 않습니다. 앱은 원격 호스트로의 SSH 터널을 사용하고 해당 터널을 통해 연결합니다.

## launchd를 선호하는 이유

- 로그인 시 자동 시작.
- 빌트인 재시작/KeepAlive 의미론.
- 예측 가능한 로그 및 감시.

참 자식 프로세스 모드가 다시 필요해지면, 별도의 명시적 개발 전용 모드로 문서화되어야 합니다.
