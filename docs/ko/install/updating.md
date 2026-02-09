---
summary: "OpenClaw 를 안전하게 업데이트하는 방법 (글로벌 설치 또는 소스), 그리고 롤백 전략"
read_when:
  - OpenClaw 업데이트
  - 업데이트 후 문제가 발생했을 때
title: "업데이트"
---

# 업데이트

OpenClaw 는 빠르게 발전하고 있습니다 (사전 “1.0”). 업데이트는 인프라 배포처럼 다루십시오: 업데이트 → 점검 실행 → 재시작 (또는 재시작을 수행하는 `openclaw update` 사용) → 검증.

## 권장: 웹사이트 설치 프로그램을 다시 실행 (제자리 업그레이드)

**권장되는** 업데이트 경로는 웹사이트의 설치 프로그램을 다시 실행하는 것입니다. 이 설치 프로그램은 기존 설치를 감지하고, 제자리에서 업그레이드하며, 필요할 경우 `openclaw doctor` 을 실행합니다.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

참고 사항:

- 온보딩 마법사가 다시 실행되지 않게 하려면 `--no-onboard` 을 추가하십시오.

- **소스 설치**의 경우 다음을 사용하십시오:

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  설치 프로그램은 리포지토리가 깨끗한 경우에 **한해서만** `git pull --rebase` 을 수행합니다.

- **글로벌 설치**의 경우, 스크립트는 내부적으로 `npm install -g openclaw@latest` 을 사용합니다.

- 레거시 참고: `clawdbot` 은 호환성 시밍으로 계속 제공됩니다.

## 업데이트 전에

- 설치 방법을 파악하십시오: **글로벌** (npm/pnpm) vs **소스에서 설치** (git clone).
- Gateway(게이트웨이) 실행 방식을 파악하십시오: **포그라운드 터미널** vs **감독 서비스** (launchd/systemd).
- 2. 맞춤 설정 스냅샷:
  - 구성: `~/.openclaw/openclaw.json`
  - 자격 증명: `~/.openclaw/credentials/`
  - 워크스페이스: `~/.openclaw/workspace`

## 업데이트 (글로벌 설치)

글로벌 설치 (하나 선택):

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

Gateway(게이트웨이) 런타임에는 Bun 을 **권장하지 않습니다** (WhatsApp/Telegram 버그).

업데이트 채널을 전환하려면 (git + npm 설치):

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

일회성 설치 태그/버전을 지정하려면 `--tag <dist-tag|version>` 을 사용하십시오.

채널 의미와 릴리스 노트는 [Development channels](/install/development-channels) 를 참고하십시오.

참고: npm 설치의 경우, Gateway(게이트웨이)는 시작 시 업데이트 힌트를 로그로 남깁니다 (현재 채널 태그를 확인). `update.checkOnStart: false` 으로 비활성화할 수 있습니다.

그 다음:

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

참고 사항:

- Gateway(게이트웨이)가 서비스로 실행 중인 경우, PID 를 강제 종료하는 것보다 `openclaw gateway restart` 을 권장합니다.
- 특정 버전에 고정되어 있다면 아래의 “롤백 / 고정”을 참고하십시오.

## 업데이트 (`openclaw update`)

**소스 설치** (git checkout)의 경우, 다음을 권장합니다:

```bash
openclaw update
```

이는 비교적 안전한 업데이트 흐름을 실행합니다:

- 깨끗한 작업 트리를 요구합니다.
- 선택된 채널 (태그 또는 브랜치)로 전환합니다.
- 구성된 업스트림 (dev 채널)을 기준으로 fetch + rebase 를 수행합니다.
- 의존성을 설치하고, 빌드하고, Control UI 를 빌드하며, `openclaw doctor` 을 실행합니다.
- 기본적으로 Gateway(게이트웨이)를 재시작합니다 (건너뛰려면 `--no-restart` 사용).

**npm/pnpm** 으로 설치한 경우 (git 메타데이터 없음), `openclaw update` 이 패키지 매니저를 통해 업데이트를 시도합니다. 설치를 감지할 수 없는 경우 “업데이트 (글로벌 설치)”를 사용하십시오.

## 업데이트 (Control UI / RPC)

Control UI 에는 **Update & Restart** (RPC: `update.run`) 가 있습니다. 이는 다음을 수행합니다:

1. `openclaw update` 과 동일한 소스 업데이트 흐름을 실행합니다 (git checkout 만 해당).
2. 구조화된 리포트 (stdout/stderr 꼬리)를 포함한 재시작 센티널을 기록합니다.
3. Gateway(게이트웨이)를 재시작하고, 마지막 활성 세션에 리포트를 핑으로 전송합니다.

rebase 가 실패하면, Gateway(게이트웨이)는 업데이트를 적용하지 않고 중단한 뒤 재시작합니다.

## 업데이트 (소스에서)

리포지토리 체크아웃에서:

권장:

```bash
openclaw update
```

수동 (거의 동일):

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw doctor
openclaw health
```

참고 사항:

- 패키징된 `openclaw` 바이너리 ([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs))를 실행하거나 Node 로 `dist/` 을 실행할 때는 `pnpm build` 이 중요합니다.
- 글로벌 설치 없이 리포지토리 체크아웃에서 실행하는 경우, CLI 명령에는 `pnpm openclaw ...` 을 사용하십시오.
- TypeScript 에서 직접 실행하는 경우 (`pnpm openclaw ...`), 재빌드는 보통 필요 없지만, **구성 마이그레이션은 여전히 적용됩니다** → doctor 를 실행하십시오.
- 글로벌 설치와 git 설치 간 전환은 쉽습니다: 다른 형태를 설치한 다음 `openclaw doctor` 을 실행하면 Gateway(게이트웨이) 서비스 엔트리포인트가 현재 설치에 맞게 다시 작성됩니다.

## 항상 실행: `openclaw doctor`

Doctor 는 “안전한 업데이트” 명령입니다. 의도적으로 단순합니다: 복구 + 마이그레이션 + 경고.

참고: **소스 설치** (git checkout) 인 경우, `openclaw doctor` 는 먼저 `openclaw update` 을 실행할 것을 제안합니다.

일반적으로 수행하는 작업:

- 더 이상 사용되지 않는 구성 키 / 레거시 구성 파일 위치를 마이그레이션합니다.
- DM 정책을 감사하고 위험한 “open” 설정에 대해 경고합니다.
- Gateway(게이트웨이) 상태를 확인하고 재시작을 제안할 수 있습니다.
- 이전 Gateway(게이트웨이) 서비스 (launchd/systemd; 레거시 schtasks)를 감지하여 현재 OpenClaw 서비스로 마이그레이션합니다.
- Linux 에서 systemd 사용자 lingering 을 보장합니다 (로그아웃 후에도 Gateway(게이트웨이)가 유지되도록).

자세한 내용: [Doctor](/gateway/doctor)

## Gateway(게이트웨이) 시작 / 중지 / 재시작

CLI (OS 와 무관하게 동작):

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

감독 환경인 경우:

- macOS launchd (앱 번들 LaunchAgent): `launchctl kickstart -k gui/$UID/bot.molt.gateway` (`bot.molt.<profile>` 사용 권장; 레거시 `com.openclaw.*` 도 여전히 동작)
- Linux systemd 사용자 서비스: `systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows (WSL2): `systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` 은 서비스가 설치된 경우에만 동작하며, 그렇지 않으면 `openclaw gateway install` 을 실행하십시오.

런북 + 정확한 서비스 레이블: [Gateway runbook](/gateway)

## 롤백 / 고정 (문제가 발생했을 때)

### 고정 (글로벌 설치)

검증된 정상 버전을 설치하십시오 (`<version>` 를 마지막으로 동작하던 버전으로 교체):

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

팁: 현재 게시된 버전을 확인하려면 `npm view openclaw version` 을 실행하십시오.

그 다음 재시작 + doctor 재실행:

```bash
openclaw doctor
openclaw gateway restart
```

### 날짜 기준 고정 (소스)

특정 날짜의 커밋을 선택하십시오 (예: “2026-01-01 기준 main 상태”):

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

그 다음 의존성 재설치 + 재시작:

```bash
pnpm install
pnpm build
openclaw gateway restart
```

나중에 최신으로 되돌리고 싶다면:

```bash
git checkout main
git pull
```

## 3. 막혔을 때

- `openclaw doctor` 을 다시 실행하고 출력 내용을 주의 깊게 읽으십시오 (대개 해결 방법이 포함되어 있습니다).
- 확인: [문제 해결](/gateway/troubleshooting)
- Discord 에서 문의: [https://discord.gg/clawd](https://discord.gg/clawd)
