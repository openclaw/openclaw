---
summary: "macOS 에서의 Gateway(게이트웨이) 수명 주기 (launchd)"
read_when:
  - mac 앱을 Gateway(게이트웨이) 수명 주기와 통합할 때
title: "Gateway(게이트웨이) 수명 주기"
---

# macOS 에서의 Gateway(게이트웨이) 수명 주기

macOS 앱은 기본적으로 **launchd 를 통해 Gateway(게이트웨이)를 관리**하며,
Gateway(게이트웨이)를 자식 프로세스로 생성하지 않습니다. 먼저 구성된 포트에서
이미 실행 중인 Gateway(게이트웨이)에 연결을 시도합니다. 도달 가능한 인스턴스가
없으면, 외부 `openclaw` CLI(내장 런타임 없음)를 통해 launchd 서비스를
활성화합니다. 이를 통해 로그인 시 안정적인 자동 시작과 크래시 시 재시작을
보장합니다.

자식 프로세스 모드(앱이 직접 Gateway(게이트웨이)를 생성)는 현재 **사용되지
않습니다**.
UI 와의 더 긴밀한 결합이 필요하다면, 터미널에서 Gateway(게이트웨이)를
수동으로 실행하십시오.

## 기본 동작 (launchd)

- 앱은 사용자별 LaunchAgent 를 설치하며 라벨은 `bot.molt.gateway` 입니다
  (`--profile`/`OPENCLAW_PROFILE` 를 사용할 경우 `bot.molt.<profile>`;
  레거시 `com.openclaw.*` 도 지원).
- 로컬 모드가 활성화되면, 앱은 LaunchAgent 가 로드되어 있는지 확인하고
  필요 시 Gateway(게이트웨이)를 시작합니다.
- 로그는 launchd Gateway(게이트웨이) 로그 경로에 기록됩니다
  (디버그 설정에서 확인 가능).

일반적인 명령:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

이름이 지정된 프로파일을 실행할 때는 라벨을 `bot.molt.<profile>` 로 바꾸십시오.

## 서명되지 않은 개발 빌드

`scripts/restart-mac.sh --no-sign` 는 서명 키가 없는 빠른 로컬 빌드를 위한 것입니다. launchd 가 서명되지 않은 릴레이 바이너리를 가리키지 않도록 다음을 수행합니다:

- `~/.openclaw/disable-launchagent` 를 작성합니다.

`scripts/restart-mac.sh` 의 서명된 실행은 해당 마커가 존재할 경우 이 오버라이드를
해제합니다. 수동으로 재설정하려면:

```bash
rm ~/.openclaw/disable-launchagent
```

## 연결 전용 모드

macOS 앱이 **launchd 를 설치하거나 관리하지 않도록** 강제하려면,
`--attach-only` (또는 `--no-launchd`) 로 실행하십시오. 이는 `~/.openclaw/disable-launchagent`
를 설정하여, 앱이 이미 실행 중인 Gateway(게이트웨이)에만 연결하도록 합니다. 동일한 동작은 디버그 설정에서도 전환할 수 있습니다.

## 원격 모드

원격 모드는 로컬 Gateway(게이트웨이)를 절대 시작하지 않습니다. 앱은 원격 호스트로 SSH 터널을 사용하고 해당 터널을 통해 연결합니다.

## launchd 를 선호하는 이유

- 로그인 시 자동 시작.
- 내장된 재시작/KeepAlive 시맨틱.
- 예측 가능한 로그와 감독.

진정한 자식 프로세스 모드가 다시 필요해진다면, 별도의 명시적인 개발 전용
모드로 문서화되어야 합니다.
