---
read_when:
    - 게이트웨이 수명주기와 Mac 앱 통합
summary: macOS의 게이트웨이 수명 주기(launchd)
title: 게이트웨이 수명주기
x-i18n:
    generated_at: "2026-02-08T15:59:43Z"
    model: gtx
    provider: google-translate
    source_hash: 9b910f574b723bc194ac663a5168e48d95f55cb468ce34c595d8ca60d3463c6a
    source_path: platforms/mac/child-process.md
    workflow: 15
---

# macOS의 게이트웨이 수명 주기

macOS 앱 **launchd를 통해 게이트웨이를 관리합니다.** 기본적으로 생성되지 않습니다.
게이트웨이를 하위 프로세스로 사용합니다. 먼저 이미 실행 중인 항목에 연결을 시도합니다.
구성된 포트의 게이트웨이 연결할 수 없는 경우 launchd를 활성화합니다.
외부를 통한 서비스 `openclaw` CLI(임베디드 런타임 없음). 이것은 당신에게 제공됩니다
로그인 시 안정적인 자동 시작 및 충돌 시 다시 시작.

하위 프로세스 모드(앱에서 직접 생성된 게이트웨이)는 **사용하지 않음** 오늘.
UI와의 긴밀한 결합이 필요한 경우 터미널에서 게이트웨이를 수동으로 실행하세요.

## 기본 동작(launchd)

- 앱은 라벨이 붙은 사용자별 LaunchAgent를 설치합니다. `bot.molt.gateway`
  (또는 `bot.molt.<profile>` 사용할 때 `--profile`/`OPENCLAW_PROFILE`; 유산 `com.openclaw.*` 지원됩니다).
- 로컬 모드가 활성화되면 앱은 LaunchAgent가 로드되고
  필요한 경우 게이트웨이를 시작합니다.
- 로그는 launchd 게이트웨이 로그 경로(디버그 설정에 표시)에 기록됩니다.

일반적인 명령:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

라벨을 다음으로 교체하세요. `bot.molt.<profile>` 명명된 프로필을 실행할 때.

## 서명되지 않은 개발 빌드

`scripts/restart-mac.sh --no-sign` 로컬 빌드가 없을 때 빠른 로컬 빌드를 위한 것입니다.
서명 키. launchd가 서명되지 않은 릴레이 바이너리를 가리키는 것을 방지하려면 다음을 수행하세요.

- 쓰기 `~/.openclaw/disable-launchagent`.

서명된 실행 `scripts/restart-mac.sh` 마커가 다음인 경우 이 재정의를 지웁니다.
현재. 수동으로 재설정하려면:

```bash
rm ~/.openclaw/disable-launchagent
```

## 연결 전용 모드

macOS 앱을 강제로 실행하려면 **launchd를 설치하거나 관리하지 마십시오**, 다음으로 시작하세요
`--attach-only`(또는 `--no-launchd`). 이 세트 `~/.openclaw/disable-launchagent`,
따라서 앱은 이미 실행 중인 게이트웨이에만 연결됩니다. 동일하게 전환할 수 있습니다.
디버그 설정의 동작.

## 원격 모드

원격 모드는 로컬 게이트웨이를 시작하지 않습니다. 앱은 SSH 터널을 사용하여
원격 호스트에 연결하고 해당 터널을 통해 연결합니다.

## 우리가 출시를 선호하는 이유

- 로그인 시 자동 시작됩니다.
- 내장된 재시작/KeepAlive 의미 체계.
- 예측 가능한 로그 및 감독.

진정한 하위 프로세스 모드가 다시 필요한 경우 다음과 같이 문서화해야 합니다.
별도의 명시적인 개발자 전용 모드입니다.
