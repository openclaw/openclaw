---
summary: "OpenClaw 를 완전히 제거합니다 (CLI, 서비스, 상태, 워크스페이스)"
read_when:
  - 머신에서 OpenClaw 를 제거하려는 경우
  - 제거 후에도 게이트웨이 서비스가 계속 실행 중인 경우
title: "제거"
---

# 제거

두 가지 경로가 있습니다:

- **쉬운 경로**: `openclaw` 가 아직 설치되어 있는 경우.
- **수동 서비스 제거**: CLI 는 없지만 서비스가 계속 실행 중인 경우.

## 쉬운 경로 (CLI 가 아직 설치됨)

권장 사항: 내장 제거 프로그램을 사용합니다:

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

`OPENCLAW_CONFIG_PATH` 를 상태 디렉토리 외부의 사용자 지정 위치로 설정한 경우, 해당 파일도 삭제하십시오.

4. 워크스페이스 삭제 (선택 사항, 에이전트 파일 제거):

```bash
rm -rf ~/.openclaw/workspace
```

5. CLI 설치 제거 (사용한 방법을 선택):

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. macOS 앱을 설치한 경우:

```bash
rm -rf /Applications/OpenClaw.app
```

참고:

- 프로파일 (`--profile` / `OPENCLAW_PROFILE`) 을 사용한 경우, 각 상태 디렉토리에 대해 3단계를 반복하십시오 (기본값은 `~/.openclaw-<profile>`).
- 원격 모드에서는 상태 디렉토리가 **게이트웨이 호스트** 에 있으므로, 해당 호스트에서도 1-4단계를 실행하십시오.

## 수동 서비스 제거 (CLI 가 설치되지 않음)

게이트웨이 서비스가 계속 실행되지만 `openclaw` 이 없는 경우 사용하십시오.

### macOS (launchd)

기본 레이블은 `bot.molt.gateway` (또는 `bot.molt.<profile>`; 레거시 `com.openclaw.*` 가 여전히 존재할 수 있음) 입니다:

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

프로파일을 사용한 경우, 레이블과 plist 이름을 `bot.molt.<profile>` 로 교체하십시오. 존재하는 경우 레거시 `com.openclaw.*` plist 도 모두 제거하십시오.

### Linux (systemd 사용자 유닛)

기본 유닛 이름은 `openclaw-gateway.service` (또는 `openclaw-gateway-<profile>.service`) 입니다:

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (예약 작업)

기본 작업 이름은 `OpenClaw Gateway` (또는 `OpenClaw Gateway (<profile>)`) 입니다.
작업 스크립트는 상태 디렉토리 아래에 있습니다.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

프로파일을 사용한 경우, 해당 작업 이름과 `~\.openclaw-<profile>\gateway.cmd` 을 삭제하십시오.

## 일반 설치 vs 소스 체크아웃

### 일반 설치 (install.sh / npm / pnpm / bun)

`https://openclaw.ai/install.sh` 또는 `install.ps1` 를 사용한 경우, CLI 는 `npm install -g openclaw@latest` 로 설치되었습니다.
`npm rm -g openclaw` 으로 제거하십시오 (해당 방식으로 설치했다면 `pnpm remove -g` / `bun remove -g` 사용).

### 소스 체크아웃 (git clone)

리포지토리 체크아웃 (`git clone` + `openclaw ...` / `bun run openclaw ...`) 에서 실행하는 경우:

1. 리포지토리를 삭제하기 **전에** 게이트웨이 서비스를 제거하십시오 (위의 쉬운 경로 또는 수동 서비스 제거 사용).
2. 리포지토리 디렉토리를 삭제하십시오.
3. 위에 설명된 대로 상태 + 워크스페이스를 제거하십시오.
