---
summary: "OpenClaw 를 완전히 제거하기 (CLI, 서비스, 상태, 워크스페이스)"
read_when:
  - OpenClaw 를 시스템에서 제거하고 싶을 때
  - 제거 후에도 게이트웨이 서비스가 여전히 실행 중일 때
title: "제거하기"
---

# 제거하기

두 가지 경로:

- `openclaw` 가 아직 설치된 경우 **간편한 경로**.
- CLI 가 사라졌지만 서비스가 여전히 실행 중인 경우 **수동 서비스 제거**.

## 간편한 경로 (CLI 여전히 설치됨)

권장: 내장된 제거 프로그램을 사용:

```bash
openclaw uninstall
```

비대화형 (자동화 / npx):

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

수동 단계 (동일한 결과):

1. 게이트웨이 서비스 중지:

```bash
openclaw gateway stop
```

2. 게이트웨이 서비스 제거 (launchd/systemd/schtasks):

```bash
openclaw gateway uninstall
```

3. 상태 + 설정 삭제:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

상태 디렉토리 외부의 사용자 설정 위치에 `OPENCLAW_CONFIG_PATH`를 설정했다면 그 파일도 삭제하십시오.

4. 워크스페이스 삭제 (선택 사항, 에이전트 파일 제거):

```bash
rm -rf ~/.openclaw/workspace
```

5. CLI 설치 제거 (사용한 설치 방법 선택):

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. macOS 앱을 설치했다면:

```bash
rm -rf /Applications/OpenClaw.app
```

참고 사항:

- 프로필 (`--profile` / `OPENCLAW_PROFILE`)을 사용했다면, 각 상태 디렉토리에 대해 3단계를 반복하십시오 (기본값은 `~/.openclaw-<profile>`).
- 원격 모드에서는 상태 디렉토리가 **게이트웨이 호스트**에 존재하므로 1-4단계를 그곳에서 실행해야 합니다.

## 수동 서비스 제거 (CLI 설치되지 않음)

게이트웨이 서비스가 계속 실행되지만 `openclaw` 가 없는 경우 사용하십시오.

### macOS (launchd)

기본 레이블은 `bot.molt.gateway` (또는 `bot.molt.<profile>`; 이전 `com.openclaw.*`가 여전히 존재할 수 있음):

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

프로필을 사용한 경우, 레이블과 plist 이름을 `bot.molt.<profile>`로 바꾸십시오. 존재할 경우 이전의 `com.openclaw.*` plist 도 제거하십시오.

### Linux (systemd 사용자 유닛)

기본 유닛 이름은 `openclaw-gateway.service` (또는 `openclaw-gateway-<profile>.service`):

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (예약된 작업)

기본 작업 이름은 `OpenClaw Gateway` (또는 `OpenClaw Gateway (<profile>)`).
작업 스크립트는 상태 디렉토리 아래에 있습니다.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

프로필을 사용한 경우, 해당 작업 이름과 `~\.openclaw-<profile>\gateway.cmd` 를 삭제하십시오.

## 일반 설치 vs 소스 체크아웃

### 일반 설치 (install.sh / npm / pnpm / bun)

`https://openclaw.ai/install.sh` 또는 `install.ps1`을 사용했다면, CLI는 `npm install -g openclaw@latest`로 설치되었습니다.
`npm rm -g openclaw` (또는 해당 방법으로 설치한 경우 `pnpm remove -g` / `bun remove -g`)로 제거하십시오.

### 소스 체크아웃 (git clone)

Repo 체크아웃 (`git clone` + `openclaw ...` / `bun run openclaw ...`) 에서 실행하는 경우:

1. Repo 를 삭제하기 **전에** 게이트웨이 서비스를 제거하십시오 (위의 간편한 경로 또는 수동 서비스 제거 사용).
2. Repo 디렉토리 삭제.
3. 위와 같이 상태 + 워크스페이스 제거.
