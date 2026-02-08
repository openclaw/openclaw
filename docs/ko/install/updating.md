---
read_when:
    - OpenClaw 업데이트 중
    - 업데이트 후 문제가 발생함
summary: OpenClaw를 안전하게 업데이트(전역 설치 또는 소스) 및 롤백 전략
title: 업데이트 중
x-i18n:
    generated_at: "2026-02-08T15:57:52Z"
    model: gtx
    provider: google-translate
    source_hash: c95c31766fb7de8c14722b33db21c4d18bb4f27f7370655a83c0ef0feb943818
    source_path: install/updating.md
    workflow: 15
---

# 업데이트 중

OpenClaw는 빠르게 발전하고 있습니다(“1.0” 이전). 업데이트를 인프라 배송처럼 처리: 업데이트 → 확인 실행 → 다시 시작(또는 `openclaw update`, 다시 시작됨) → 확인합니다.

## 권장사항: 웹사이트 설치 프로그램을 다시 실행하세요(그 자리에서 업그레이드).

그만큼 **우선의** 업데이트 경로는 웹사이트에서 설치 프로그램을 다시 실행하는 것입니다. 그것
기존 설치를 감지하고 적절한 업그레이드를 실행합니다. `openclaw doctor` 언제
필요합니다.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

참고:

- 추가하다 `--no-onboard` 온보딩 마법사를 다시 실행하지 않으려는 경우.
- 을 위한 **소스 설치**, 사용:

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  설치 프로그램이 `git pull --rebase` **오직** 저장소가 깨끗한 경우.

- 을 위한 **글로벌 설치**, 스크립트는 다음을 사용합니다. `npm install -g openclaw@latest` 후드 아래.
- 기존 참고사항: `clawdbot` 호환성 심으로 계속 사용할 수 있습니다.

## 업데이트하기 전에

- 설치 방법을 알아 두십시오. **글로벌** (npm/pnpm) 대 **소스에서** (git 클론).
- 게이트웨이가 어떻게 실행되고 있는지 알아보세요. **전경 터미널** 대 **감독 서비스** (launchd/systemd).
- 맞춤 제작 스냅샷:
  - 구성: `~/.openclaw/openclaw.json`
  - 신임장: `~/.openclaw/credentials/`
  - 작업 공간: `~/.openclaw/workspace`

## 업데이트(전역 설치)

전역 설치(하나 선택):

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

우리는 **~ 아니다** 게이트웨이 런타임(WhatsApp/Telegram 버그)에 Bun을 추천합니다.

업데이트 채널을 전환하려면(git + npm 설치):

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

사용 `--tag <dist-tag|version>` 일회성 설치 태그/버전의 경우.

보다 [개발 채널](/install/development-channels) 채널 의미 및 릴리스 노트.

참고: npm 설치 시 게이트웨이는 시작 시 업데이트 힌트를 기록합니다(현재 채널 태그 확인). 다음을 통해 비활성화 `update.checkOnStart: false`.

그 다음에:

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

참고:

- 게이트웨이가 서비스로 실행되는 경우 `openclaw gateway restart` PID를 죽이는 것보다 선호됩니다.
- 특정 버전에 고정된 경우 아래의 '롤백/고정'을 참조하세요.

## 업데이트 (`openclaw update`)

을 위한 **소스 설치** (git checkout) 다음을 선호합니다:

```bash
openclaw update
```

안전한 업데이트 흐름을 실행합니다.

- 깨끗한 작업 트리가 필요합니다.
- 선택한 채널(태그 또는 분기)로 전환합니다.
- 구성된 업스트림(개발 채널)에 대해 가져오기 + 리베이스를 수행합니다.
- Deps를 설치하고, 빌드하고, Control UI를 빌드하고 실행합니다. `openclaw doctor`.
- 기본적으로 게이트웨이를 다시 시작합니다(사용 `--no-restart` 건너 뛰기).

통해 설치한 경우 **npm/pnpm** (git 메타데이터 없음), `openclaw update` 패키지 관리자를 통해 업데이트를 시도합니다. 설치를 감지할 수 없으면 대신 "업데이트(전역 설치)"를 사용하십시오.

## 업데이트(컨트롤 UI/RPC)

컨트롤 UI에는 **업데이트 및 다시 시작** (RPC: `update.run`). 그것:

1. 다음과 동일한 소스 업데이트 흐름을 실행합니다. `openclaw update` (git 체크아웃에만 해당)
2. 구조화된 보고서(stdout/stderr tail)로 재시작 센티널을 작성합니다.
3. 게이트웨이를 다시 시작하고 보고서를 사용하여 마지막 활성 세션을 ping합니다.

리베이스가 실패하면 업데이트를 적용하지 않고 게이트웨이가 중단되고 다시 시작됩니다.

## 업데이트(소스에서)

저장소 체크아웃에서:

우선의:

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

- `pnpm build` 패키지를 실행할 때 중요합니다. `openclaw` 바이너리([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)) 또는 노드를 사용하여 실행 `dist/`.
- 전역 설치 없이 repo 체크아웃에서 실행하는 경우 다음을 사용하세요. `pnpm openclaw ...` CLI 명령의 경우.
- TypeScript에서 직접 실행하는 경우(`pnpm openclaw ...`) 일반적으로 재구축은 불필요하지만 **구성 마이그레이션이 계속 적용됩니다.** → 의사를 실행하십시오.
- 전역 설치와 Git 설치 간 전환은 쉽습니다. 다른 버전을 설치한 다음 실행하세요. `openclaw doctor` 따라서 게이트웨이 서비스 진입점이 현재 설치로 다시 작성됩니다.

## 항상 실행: `openclaw doctor`

Doctor는 "안전한 업데이트" 명령입니다. 의도적으로 지루합니다. 수리 + 마이그레이션 + 경고.

참고: **소스 설치** (git 체크아웃), `openclaw doctor` 달리기를 제안할 것이다 `openclaw update` 첫 번째.

일반적인 작업:

- 더 이상 사용되지 않는 구성 키/기존 구성 파일 위치를 마이그레이션합니다.
- DM 정책을 감사하고 위험한 "공개" 설정에 대해 경고합니다.
- 게이트웨이 상태를 확인하고 다시 시작하도록 제안할 수 있습니다.
- 이전 게이트웨이 서비스(launchd/systemd, 레거시 schtasks)를 감지하고 현재 OpenClaw 서비스로 마이그레이션합니다.
- Linux에서는 systemd 사용자가 계속 대기하는지 확인하세요(게이트웨이가 로그아웃 후에도 유지되도록).

세부: [의사](/gateway/doctor)

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

- macOS 출시(앱 번들 LaunchAgent): `launchctl kickstart -k gui/$UID/bot.molt.gateway` (사용 `bot.molt.<profile>`; 유산 `com.openclaw.*` 여전히 작동합니다)
- Linux 시스템 사용자 서비스: `systemctl --user restart openclaw-gateway[-<profile>].service`
- 윈도우(WSL2): `systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` 서비스가 설치된 경우에만 작동합니다. 그렇지 않으면 실행 `openclaw gateway install`.

런북 + 정확한 서비스 라벨: [게이트웨이 런북](/gateway)

## 롤백/고정(무엇이 중단된 경우)

### 핀(전역 설치)

알려진 양호한 버전을 설치합니다(교체 `<version>` 마지막 작업과 함께):

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

팁: 현재 게시된 버전을 보려면 다음을 실행하세요. `npm view openclaw version`.

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

## 막힌 경우

- 달리다 `openclaw doctor` 다시 한 번 출력 내용을 주의 깊게 읽어 보십시오(수정 사항을 알려주는 경우가 많습니다).
- 확인하다: [문제 해결](/gateway/troubleshooting)
- Discord에서 질문하세요: [https://discord.gg/clawd](https://discord.gg/clawd)
