---
summary: "macOS에서의 게이트웨이 수명주기 (launchd)"
read_when:
  - Mac 앱을 게이트웨이 수명주기와 통합하기
title: "게이트웨이 수명주기"
---

# macOS에서의 게이트웨이 수명주기

macOS 앱은 기본적으로 **launchd를 통해 게이트웨이를 관리**하며, 게이트웨이를 자식 프로세스로 생성하지 않습니다. 먼저 설정된 포트에서 이미 실행 중인 게이트웨이에 연결하려고 시도하며, 연결할 수 없으면 외부 `openclaw` CLI를 통해 launchd 서비스를 활성화합니다 (내장 런타임 없음). 이렇게 하면 로그인 시 자동 시작과 충돌 시 재시작이 가능합니다.

자식 프로세스 모드 (앱이 게이트웨이를 직접 생성)는 오늘날 사용되지 않습니다. UI와의 더 강력한 결합이 필요하다면 터미널에서 수동으로 게이트웨이를 실행하십시오.

## 기본 동작 (launchd)

- 앱은 `bot.molt.gateway`로 라벨이 지정된 사용자별 LaunchAgent를 설치합니다
  (`--profile`/`OPENCLAW_PROFILE`를 사용하는 경우 `bot.molt.<profile>`; 기존 `com.openclaw.*`는 지원합니다).
- 로컬 모드가 활성화되면, 앱은 LaunchAgent가 로드되었음을 확인하고 필요에 따라 게이트웨이를 시작합니다.
- 로그는 launchd 게이트웨이 로그 경로에 기록됩니다 (디버그 설정에서 확인 가능).

일반적인 명령어:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

이름이 지정된 프로파일을 실행할 때는 라벨을 `bot.molt.<profile>`로 교체하십시오.

## 서명이 없는 개발 빌드

`signing keys`가 없을 때 빠른 로컬 빌드를 위해 `scripts/restart-mac.sh --no-sign`을 사용합니다. launchd가 서명되지 않은 릴레이 바이너리를 가리키지 않도록 하기 위해, 다음을 수행합니다:

- `~/.openclaw/disable-launchagent`을 작성합니다.

`scripts/restart-mac.sh`의 서명된 실행은 마커가 있을 경우 이 오버라이드를 제거합니다. 수동으로 재설정하려면:

```bash
rm ~/.openclaw/disable-launchagent
```

## 연결 전용 모드

macOS 앱이 **절대 launchd를 설치하거나 관리하지 않도록** 강제하려면 `--attach-only` (또는 `--no-launchd`) 로 실행하십시오. 이는 `~/.openclaw/disable-launchagent`를 설정하여, 앱이 이미 실행 중인 게이트웨이에만 연결하도록 합니다. 같은 동작은 디버그 설정에서도 토글할 수 있습니다.

## 원격 모드

원격 모드는 로컬 게이트웨이를 절대 시작하지 않습니다. 앱은 원격 호스트로 SSH 터널을 사용하며 그 터널을 통해 연결합니다.

## 우리가 launchd를 선호하는 이유

- 로그인 시 자동 시작.
- 내장된 재시작/KeepAlive 의미론.
- 예측 가능한 로그와 감독.

진정한 자식 프로세스 모드가 다시 필요해진다면, 별도의 명확한 개발 전용 모드로 문서화되어야 합니다.
