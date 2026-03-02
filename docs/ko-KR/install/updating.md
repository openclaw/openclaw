---
summary: "OpenClaw 를 안전하게 업데이트합니다 (전역 설치 또는 소스) 및 롤백 전략"
read_when:
  - OpenClaw 를 업데이트할 때
  - 업데이트 후 무언가 손상될 때
title: "업데이트"
---

# 업데이트

OpenClaw 는 빠르게 움직이고 있습니다 (사전 "1.0"). 업데이트를 인프라 배송처럼 처리합니다: 업데이트 → 검사 실행 → 재시작 (또는 `openclaw update` 사용, 재시작함) → 확인.

## 권장: 웹사이트 설치자 다시 실행 (제자리에서 업그레이드)

**선호하는** 업데이트 경로는 웹사이트에서 설치자를 다시 실행하는 것입니다. 기존 설치를 감지하고, 제자리에서 업그레이드하며, 필요할 때 `openclaw doctor` 를 실행합니다.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

참고:

- 온보딩 마법사를 다시 실행하지 않으려면 `--no-onboard` 를 추가합니다.
- **소스 설치** 의 경우:

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  설치자는 리포지토리가 깨끗한 경우에만 `git pull --rebase` 를 실행합니다.

- **전역 설치** 의 경우 스크립트는 내부적으로 `npm install -g openclaw@latest` 를 사용합니다.

## 업데이트 전에

- 설치 방법을 알고 있습니다: **전역** (npm/pnpm) vs **소스에서** (git clone).
- Gateway 가 어떻게 실행 중인지 알고 있습니다: **포어그라운드 터미널** vs **감시자 서비스** (launchd/systemd).
- 스냅샷 사용자 정의:
  - 구성: `~/.openclaw/openclaw.json`
  - 자격 증명: `~/.openclaw/credentials/`
  - 워크스페이스: `~/.openclaw/workspace`

## 업데이트 (전역 설치)

전역 설치 (하나를 선택합니다):

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

Gateway 런타임에 Bun 을 권장하지 않습니다 (WhatsApp/Telegram 버그).

업데이트 채널을 전환하려면 (git + npm 설치):

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

일회용 설치 태그/버전으로 `--tag <dist-tag|version>` 를 사용합니다.

[Development channels](/install/development-channels) 를 참조하여 채널 의미론 및 릴리스 노트를 확인합니다.

참고: npm 설치에서 Gateway 는 시작 시 업데이트 힌트를 기록합니다 (현재 채널 태그 확인). `update.checkOnStart: false` 를 통해 비활성화합니다.

### Core 자동 업데이터 (선택 사항)

자동 업데이터는 **기본적으로 꺼져 있으며** 핵심 Gateway 기능입니다 (플러그인 아님).

```json
{
  "update": {
    "channel": "stable",
    "auto": {
      "enabled": true,
      "stableDelayHours": 6,
      "stableJitterHours": 12,
      "betaCheckIntervalHours": 1
    }
  }
}
```

동작:

- `stable`: 새 버전이 표시되면 OpenClaw 는 `stableDelayHours` 를 기다린 다음 `stableJitterHours` 에서 결정적 per-install jitter 를 적용합니다 (롤아웃 분산).
- `beta`: `betaCheckIntervalHours` cadence 에서 확인하고 (기본값: 매시간) 업데이트를 사용할 수 있을 때 적용합니다.
- `dev`: 자동 적용 없음; `openclaw update` 수동 사용.

`openclaw update --dry-run` 을 사용하여 자동화를 활성화하기 전에 업데이트 작업을 미리봅니다.

그런 다음:

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

참고:

- Gateway 가 서비스로 실행되면 `openclaw gateway restart` 가 PID 를 종료하는 것보다 선호됩니다.
- 특정 버전에 고정되어 있으면 아래의 "롤백 / 고정" 을 참조합니다.

## 업데이트 (소스에서)

리포지토리 체크아웃에서 (git 체크아웃):

```bash
openclaw update
```

안전한 업데이트 흐름을 실행합니다:

- 깨끗한 worktree 필요.
- 선택한 채널 (태그 또는 브랜치) 로 전환.
- 구성된 업스트림 (개발 채널) 에 대해 가져오기 + rebase.
- deps 설치, 빌드, Control UI 빌드 및 `openclaw doctor` 실행.
- 기본적으로 Gateway 를 재시작합니다 (`--no-restart` 를 건너뜁니다).

**npm/pnpm** (git 메타데이터 없음) 을 통해 설치한 경우 `openclaw update` 는 패키지 관리자를 통해 업데이트하려고 시도합니다. 설치를 감지할 수 없으면 대신 "Update (global install)" 을 사용합니다.

## 항상 실행: `openclaw doctor`

Doctor 는 "safe update" 명령입니다. 의도적으로 지루합니다: repair + migrate + warn.

참고: **소스 설치** (git 체크아웃) 에서 `openclaw doctor` 는 먼저 `openclaw update` 를 실행하도록 제공할 것입니다.

전형적인 것들:

- 지원되지 않는 구성 키 / 레거시 구성 파일 위치를 마이그레이션.
- DM 정책을 감사하고 위험한 "열린" 설정에 경고.
- Gateway 건강을 확인하고 재시작을 제공할 수 있습니다.
- 이전 Gateway 서비스 (launchd/systemd; 레거시 schtasks) 를 현재 OpenClaw 서비스로 감지 및 마이그레이션.
- Linux 에서 systemd 사용자 lingering 을 확인합니다 (그래서 Gateway 는 로그아웃 후에도 지속됨).

세부 정보: [Doctor](/gateway/doctor)

## Gateway 시작 / 중지 / 재시작

CLI (OS 와 관계없이 작동):

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

감시자인 경우:

- macOS launchd (앱 번들 LaunchAgent): `launchctl kickstart -k gui/$UID/ai.openclaw.gateway` (`ai.openclaw.<profile>` 사용; 레거시 `com.openclaw.*` 여전히 작동)
- Linux systemd 사용자 서비스: `systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows (WSL2): `systemctl --user restart openclaw-gateway[-<profile>].service`

`launchctl`/`systemctl` 는 서비스가 설치된 경우에만 작동합니다. 그렇지 않으면 `openclaw gateway install` 를 실행합니다.

Runbook + 정확한 서비스 레이블: [Gateway runbook](/gateway)

## 롤백 / 고정 (무언가 손상될 때)

### 고정 (전역 설치)

알려진 좋은 버전을 설치합니다 (`<version>` 을 마지막 작동 버전으로 바꿉니다):

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

팁: 현재 발행된 버전을 보려면 `npm view openclaw version` 을 실행합니다.

그런 다음 재시작 + doctor 다시 실행:

```bash
openclaw doctor
openclaw gateway restart
```

### 고정 (소스) 날짜별

날짜에서 커밋을 선택합니다 (예: "2026-01-01 기준 main 의 상태"):

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

그런 다음 deps 다시 설치 + 재시작:

```bash
pnpm install
pnpm build
openclaw gateway restart
```

나중에 최신으로 돌아가려면:

```bash
git checkout main
git pull
```

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/install/updating.md
workflow: 15
