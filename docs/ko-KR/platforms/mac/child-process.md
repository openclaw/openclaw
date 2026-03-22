---
summary: "macOS 에서의 Gateway 라이프사이클 (launchd)"
read_when:
  - Mac 앱을 Gateway 라이프사이클과 통합할 때
title: "Gateway 라이프사이클"
x-i18n:
  source_path: docs/platforms/mac/child-process.md
---

# macOS 에서의 Gateway 라이프사이클

macOS 앱은 기본적으로 **launchd 를 통해 Gateway 를 관리**하며 Gateway 를 자식
프로세스로 생성하지 않습니다. 먼저 설정된 포트에서 이미 실행 중인 Gateway 에
연결을 시도합니다; 접근 가능한 것이 없으면 외부 `openclaw` CLI (내장 런타임 없음) 를 통해
launchd 서비스를 활성화합니다. 이렇게 하면 로그인 시 안정적인 자동 시작과
충돌 시 재시작이 가능합니다.

자식 프로세스 모드 (앱이 직접 Gateway 를 생성) 는 현재 **사용되지 않습니다**.
UI 와 더 긴밀한 결합이 필요하면 터미널에서 Gateway 를 수동으로 실행하세요.

## 기본 동작 (launchd)

- 앱은 `ai.openclaw.gateway` 레이블의 사용자별 LaunchAgent 를 설치합니다
  (`--profile`/`OPENCLAW_PROFILE` 사용 시 `ai.openclaw.<profile>`; 레거시 `com.openclaw.*` 도 지원).
- 로컬 모드가 활성화되면, 앱은 LaunchAgent 가 로드되어 있는지 확인하고
  필요시 Gateway 를 시작합니다.
- 로그는 launchd Gateway 로그 경로에 작성됩니다 (디버그 설정에서 확인 가능).

주요 명령:

```bash
launchctl kickstart -k gui/$UID/ai.openclaw.gateway
launchctl bootout gui/$UID/ai.openclaw.gateway
```

명명된 프로파일을 실행할 때는 레이블을 `ai.openclaw.<profile>` 로 교체하세요.

## 서명되지 않은 개발 빌드

`scripts/restart-mac.sh --no-sign` 은 서명 키가 없을 때 빠른 로컬 빌드를 위한 것입니다.
launchd 가 서명되지 않은 릴레이 바이너리를 가리키는 것을 방지하기 위해:

- `~/.openclaw/disable-launchagent` 를 작성합니다.

서명된 `scripts/restart-mac.sh` 실행은 마커가 있으면 이 오버라이드를 지웁니다.
수동으로 초기화하려면:

```bash
rm ~/.openclaw/disable-launchagent
```

## 연결 전용 모드

macOS 앱이 **launchd 를 설치하거나 관리하지 않도록** 강제하려면,
`--attach-only` (또는 `--no-launchd`) 로 실행하세요. 이렇게 하면 `~/.openclaw/disable-launchagent` 가 설정되어
앱은 이미 실행 중인 Gateway 에만 연결합니다. 디버그 설정에서 동일한 동작을
토글할 수 있습니다.

## 원격 모드

원격 모드는 로컬 Gateway 를 시작하지 않습니다. 앱은 원격 호스트에 대한 SSH 터널을
사용하고 해당 터널을 통해 연결합니다.

## launchd 를 선호하는 이유

- 로그인 시 자동 시작.
- 내장 재시작/KeepAlive 시맨틱.
- 예측 가능한 로그 및 감독.

진정한 자식 프로세스 모드가 다시 필요하다면, 별도의 명시적 개발 전용 모드로
문서화되어야 합니다.
