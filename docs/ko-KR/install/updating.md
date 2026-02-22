---
summary: "OpenClaw 업데이트 안전하게 수행하기 (글로벌 설치 또는 소스에서), 롤백 전략 포함"
read_when:
  - OpenClaw 업데이트 중
  - 업데이트 후 문제가 발생했을 때
title: "업데이트 중"
---

# 업데이트 중

OpenClaw는 빠르게 발전 중입니다 (버전 1.0 이전). 업데이트는 인프라 배포처럼 다루세요: 업데이트 → 확인 실행 → 재시작 (또는 `openclaw update` 사용, 자동 재시작) → 검증.

## 권장: 웹사이트 설치 프로그램 다시 실행 (제자리 업그레이드)

가장 **선호되는** 업데이트 방법은 웹사이트에서 설치 프로그램을 다시 실행하는 것입니다. 이 방법은 기존 설치를 감지하고 제자리에서 업그레이드하며 필요할 때 `openclaw doctor`를 실행합니다.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

참고 사항:

- 온보딩 마법사가 다시 실행되지 않도록 하려면 `--no-onboard`를 추가하세요.
- **소스 설치**의 경우:
  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```
  설치 프로그램은 **저장소가 깨끗한 경우에만** `git pull --rebase`를 수행합니다.
- **글로벌 설치**의 경우, 스크립트는 내부적으로 `npm install -g openclaw@latest`를 사용합니다.
- 레거시 참고 사항: `clawdbot`은 호환성 셈으로 계속 제공됩니다.

## 업데이트 전에

- 설치 방식을 알아두세요: **글로벌** (npm/pnpm) 또는 **소스에서** (git clone).
- 게이트웨이 실행 방식을 알아두세요: **전경 터미널** 또는 **감시 서비스** (launchd/systemd).
- 맞춤 설정 스냅샷 저장:
  - 설정: `~/.openclaw/openclaw.json`
  - 자격 증명: `~/.openclaw/credentials/`
  - 작업 공간: `~/.openclaw/workspace`

## 업데이트 (글로벌 설치)

글로벌 설치 (하나 선택):

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

게이트웨이 런타임에 Bun을 **추천하지 않습니다** (WhatsApp/Telegram 버그).

업데이트 채널 전환하기 (git + npm 설치):

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

단발성 설치 태그/버전을 위해 `--tag <dist-tag|version>` 사용.

[개발 채널](/ko-KR/install/development-channels)에서 채널 의미와 릴리즈 노트를 참조하세요.

참고: npm 설치 시, 게이트웨이는 시작 시 업데이트 힌트를 로깅합니다 (현재 채널 태그를 확인). `update.checkOnStart: false`로 비활성화하세요.

이후:

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

참고 사항:

- 게이트웨이가 서비스로 실행 중이라면, PID를 죽이는 것보다 `openclaw gateway restart`가 우선입니다.
- 특정 버전에 고정되어 있다면 아래 "롤백 / 고정"을 참조하세요.

## 업데이트 (`openclaw update`)

**소스 설치** (git checkout)의 경우, 다음을 권장합니다:

```bash
openclaw update
```

안전한-ish 업데이트 흐름을 실행합니다:

- 깨끗한 작업 트리가 필요합니다.
- 선택한 채널(태그 또는 브랜치)로 스위치합니다.
- 설정된 업스트림(개발 채널)과 비교하여 가져오고 리베이스합니다.
- 의존성을 설치하고, 빌드하며, Control UI를 빌드하고 `openclaw doctor`를 실행합니다.
- 기본적으로 게이트웨이를 재시작합니다 (`--no-restart`를 사용하여 건너뜀).

**npm/pnpm**(git 메타데이터 없음)으로 설치한 경우, `openclaw update`는 패키지 관리자를 통해 업데이트를 시도합니다. 설치를 감지하지 못하면 "업데이트 (글로벌 설치)"를 대신 사용하세요.

## 업데이트 (Control UI / RPC)

Control UI에는 **업데이트 & 재시작** (RPC: `update.run`)이 있습니다. 이것은:

1. `openclaw update`와 동일한 소스 업데이트 흐름을 실행합니다 (git checkout 전용).
2. 구조화된 보고서(stdout/stderr tail)와 함께 재시작 신호를 씁니다.
3. 게이트웨이를 재시작하고 마지막 활성 세션에 보고서를 전송합니다.

리베이스가 실패하면 게이트웨이는 업데이트를 적용하지 않고 중단 후 재시작합니다.

## 업데이트 (소스에서)

저장소 체크아웃에서:

선호 방법:

```bash
openclaw update
```

수동 방법 (대략적인):

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # 처음 실행 시 UI 의존성 자동 설치
openclaw doctor
openclaw health
```

참고 사항:

- `pnpm build`는 패키지된 `openclaw` 바이너리([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs))를 실행하거나 Node를 사용하여 `dist/`를 실행할 때 중요합니다.
- 전역 설치 없이 저장소 체크아웃에서 실행하는 경우, CLI 명령어는 `pnpm openclaw ...`를 사용하세요.
- TypeScript에서 직접 실행할 경우(`pnpm openclaw ...`), 일반적으로 리빌드가 필요 없지만 **설정 마이그레이션은 여전히 적용됨** → doctor 실행.
- 글로벌 설치와 git 설치 간 전환은 쉽습니다: 다른 유형을 설치한 후, `openclaw doctor`를 실행하여 게이트웨이 서비스 진입점을 현재 설치로 다시 작성하세요.

## 항상 실행: `openclaw doctor`

Doctor는 "안전한 업데이트" 명령어입니다. 의도적으로 지루합니다: 복구 + 마이그레이션 + 경고.

참고: **소스 설치**(git checkout)인 경우, `openclaw doctor`는 먼저 `openclaw update`를 실행할 것을 제안합니다.

일반적으로 수행하는 작업:

- 사용 중지된 설정 키 / 레거시 설정 파일 위치를 마이그레이션합니다.
- 다이렉트 메시지 정책을 감사하고 위험한 "open" 설정에 대해 경고합니다.
- 게이트웨이 상태를 확인하고 재시작을 제안할 수 있습니다.
- 오래된 게이트웨이 서비스를 현재 OpenClaw 서비스로 감지 및 마이그레이션합니다 (launchd/systemd; 레거시 schtasks).
- Linux에서 시스템 사용자 지속 상태를 확인하여 게이트웨이가 로그아웃 후에도 살아남도록 합니다.

자세한 내용: [Doctor](/ko-KR/gateway/doctor)

## 게이트웨이 시작/중지/재시작

CLI (운영체제와 무관하게 작동):

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

감시 중이라면:

- macOS launchd (앱 번들 LaunchAgent): `launchctl kickstart -k gui/$UID/bot.molt.gateway` (`bot.molt.<profile>` 사용; 레거시 `com.openclaw.*` 여전히 작동)
- Linux systemd 사용자 서비스: `systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows (WSL2): `systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl`은 서비스가 설치된 경우에만 작동; 그렇지 않으면 `openclaw gateway install` 실행.

런북과 정확한 서비스 레이블: [Gateway runbook](/ko-KR/gateway)

## 롤백 / 고정 (문제가 발생했을 때)

### 핀 (글로벌 설치)

알려진 좋은 버전을 설치합니다 (마지막으로 작동한 버전으로 `<version>`을 대체):

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

팁: 현재 게시된 버전을 보려면 `npm view openclaw version`을 실행하세요.

그런 다음 재시작 + doctor 재실행:

```bash
openclaw doctor
openclaw gateway restart
```

### 핀 (소스) 날짜별

날짜에서 커밋 선택 (예: “2026-01-01일의 메인 상태”):

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

그런 다음 의존성 재설치 + 재시작:

```bash
pnpm install
pnpm build
openclaw gateway restart
```

나중에 최신 상태로 돌아가려면:

```bash
git checkout main
git pull
```

## 해결할 수 없는 경우

- `openclaw doctor`를 다시 실행하고 출력을 주의 깊게 읽으세요 (종종 해결 방법을 알려줍니다).
- 확인: [문제 해결](/ko-KR/gateway/troubleshooting)
- Discord에 문의하세요: [https://discord.gg/clawd](https://discord.gg/clawd)