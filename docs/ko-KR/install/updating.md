---
summary: "Updating OpenClaw safely (global install or source), plus rollback strategy"
read_when:
  - Updating OpenClaw
  - Something breaks after an update
title: "Updating"
x-i18n:
  source_hash: c95c31766fb7de8c14722b33db21c4d18bb4f27f7370655a83c0ef0feb943818
---

# 업데이트 중

OpenClaw는 빠르게 발전하고 있습니다(“1.0” 이전). 업데이트를 인프라 배송처럼 처리합니다. 업데이트 → 확인 실행 → 다시 시작(또는 다시 시작하는 `openclaw update` 사용) → 확인합니다.

## 권장 사항: 웹사이트 설치 프로그램을 다시 실행하세요(그 자리에서 업그레이드).

**선호** 업데이트 경로는 웹사이트에서 설치 프로그램을 다시 실행합니다. 그것
기존 설치를 감지하고 업그레이드하며 다음과 같은 경우 `openclaw doctor`를 실행합니다.
필요합니다.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

참고:

- 온보딩 마법사를 다시 실행하지 않으려면 `--no-onboard`를 추가하세요.
- **소스 설치**의 경우 다음을 사용합니다.

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  설치 프로그램은 저장소가 깨끗한 경우에만 `git pull --rebase` **만** 합니다.

- **전역 설치**의 경우 스크립트는 내부적으로 `npm install -g openclaw@latest`를 사용합니다.
- 기존 참고 사항: `clawdbot`는 호환성 심으로 계속 사용 가능합니다.

## 업데이트하기 전에

- 설치 방법을 파악하세요: **전역**(npm/pnpm) 및 **소스에서**(git clone).
- 게이트웨이가 어떻게 실행되고 있는지 알아보세요: **포그라운드 터미널** 및 **감독 서비스**(launchd/systemd).
- 맞춤 제작 스냅샷:
  - 구성: `~/.openclaw/openclaw.json`
  - 자격 증명: `~/.openclaw/credentials/`
  - 작업공간: `~/.openclaw/workspace`

## 업데이트(전역 설치)

전역 설치(하나 선택):

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

게이트웨이 런타임(WhatsApp/Telegram 버그)에는 Bun을 권장하지 **않습니다**.

업데이트 채널을 전환하려면(git + npm 설치):

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

일회성 설치 태그/버전에는 `--tag <dist-tag|version>`를 사용하세요.

채널 의미 및 릴리스 노트는 [개발 채널](/install/development-channels)을 참조하세요.

참고: npm 설치 시 게이트웨이는 시작 시 업데이트 힌트를 기록합니다(현재 채널 태그 확인). `update.checkOnStart: false`를 통해 비활성화합니다.

그런 다음:

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

참고:

- 게이트웨이가 서비스로 실행되는 경우 PID를 죽이는 것보다 `openclaw gateway restart`가 선호됩니다.
- 특정 버전에 고정되어 있는 경우 아래 “롤백/고정”을 참고하세요.

## 업데이트 (`openclaw update`)

**소스 설치**(git checkout)의 경우 다음을 선호하세요.

```bash
openclaw update
```

안전한 업데이트 흐름을 실행합니다.

- 깨끗한 작업 트리가 필요합니다.
- 선택한 채널(태그 또는 브랜치)로 전환합니다.
- 구성된 업스트림(개발 채널)에 대해 가져오기 + 리베이스를 수행합니다.
- deps를 설치하고, 빌드하고, Control UI를 빌드하고 `openclaw doctor`를 실행합니다.
- 기본적으로 게이트웨이를 다시 시작합니다(건너뛰려면 `--no-restart` 사용).

**npm/pnpm**(git 메타데이터 없음)을 통해 설치한 경우 `openclaw update`는 패키지 관리자를 통해 업데이트를 시도합니다. 설치를 감지할 수 없으면 대신 "업데이트(전역 설치)"를 사용하십시오.

## 업데이트 (컨트롤 UI / RPC)

제어 UI에는 **업데이트 및 다시 시작**(RPC: `update.run`)이 있습니다. 그것:

1. `openclaw update`와 동일한 소스 업데이트 흐름을 실행합니다(git checkout에만 해당).
2. 구조화된 보고서(stdout/stderr tail)로 재시작 센티널을 작성합니다.
3. 게이트웨이를 다시 시작하고 보고서를 사용하여 마지막 활성 세션을 ping합니다.

리베이스가 실패하면 업데이트를 적용하지 않고 게이트웨이가 중단되고 다시 시작됩니다.

## 업데이트(소스에서)

저장소 체크아웃에서:

선호:

```bash
openclaw update
```

수동(동등):

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw doctor
openclaw health
```

참고:

- `pnpm build`는 패키지된 `openclaw` 바이너리([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs))를 실행하거나 노드를 사용하여 `dist/`를 실행할 때 중요합니다.
- 전역 설치 없이 repo 체크아웃에서 실행하는 경우 CLI 명령에 `pnpm openclaw ...`를 사용합니다.
- TypeScript(`pnpm openclaw ...`)에서 직접 실행하는 경우 일반적으로 다시 빌드가 필요하지 않지만 **config 마이그레이션은 계속 적용됩니다** → doctor를 실행합니다.
- 전역 설치와 Git 설치 간 전환은 쉽습니다. 다른 버전을 설치한 다음 `openclaw doctor`를 실행하면 게이트웨이 서비스 진입점이 현재 설치로 다시 작성됩니다.

## 항상 실행: `openclaw doctor`

Doctor는 "안전한 업데이트" 명령입니다. 의도적으로 지루합니다. 수리 + 마이그레이션 + 경고.

참고: **소스 설치**(git checkout) 중인 경우 `openclaw doctor`는 `openclaw update`를 먼저 실행하도록 제안합니다.

일반적인 작업:

- 더 이상 사용되지 않는 구성 키/레거시 구성 파일 위치를 마이그레이션합니다.
- DM 정책을 감사하고 위험한 "공개" 설정에 대해 경고합니다.
- 게이트웨이 상태를 확인하고 다시 시작하도록 제안할 수 있습니다.
- 이전 게이트웨이 서비스(launchd/systemd, 레거시 schtasks)를 감지하고 현재 OpenClaw 서비스로 마이그레이션합니다.
- Linux에서는 systemd 사용자가 계속 유지되는지 확인하세요(Gateway가 로그아웃 후에도 유지되도록).

세부정보: [의사](/gateway/doctor)

## 게이트웨이 시작/중지/다시 시작

CLI(OS에 관계없이 작동):

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

감독 대상인 경우:

- macOS 출시(앱 번들 LaunchAgent): `launchctl kickstart -k gui/$UID/bot.molt.gateway` (`bot.molt.<profile>` 사용, 레거시 `com.openclaw.*` 여전히 작동함)
- Linux 시스템 사용자 서비스: `systemctl --user restart openclaw-gateway[-<profile>].service`
- 윈도우(WSL2): `systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl`는 서비스가 설치된 경우에만 작동합니다. 그렇지 않으면 `openclaw gateway install`를 실행하세요.

런북 + 정확한 서비스 레이블: [게이트웨이 런북](/gateway)

## 롤백/고정(무엇이 중단된 경우)

### 핀(전역 설치)

알려진 양호한 버전을 설치합니다(`<version>`를 마지막으로 작동하는 버전으로 교체):

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

팁: 현재 게시된 버전을 보려면 `npm view openclaw version`를 실행하세요.

그런 다음 의사를 다시 시작하고 다시 실행하십시오.

```bash
openclaw doctor
openclaw gateway restart
```

### 날짜별 핀(출처)

날짜에서 커밋을 선택합니다(예: "2026년 1월 1일 기준 기본 상태").

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

그런 다음 deps를 다시 설치하고 다시 시작합니다.

```bash
pnpm install
pnpm build
openclaw gateway restart
```

나중에 최신 버전으로 돌아가고 싶다면:

```bash
git checkout main
git pull
```

## 막히면

- `openclaw doctor`를 다시 실행하고 출력을 주의 깊게 읽으십시오(수정 사항을 알려주는 경우가 많습니다).
- 확인: [문제 해결](/gateway/troubleshooting)
- 디스코드에서 질문하기: [https://discord.gg/clawd](https://discord.gg/clawd)
