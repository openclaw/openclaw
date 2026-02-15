---
summary: "Uninstall OpenClaw completely (CLI, service, state, workspace)"
read_when:
  - You want to remove OpenClaw from a machine
  - The gateway service is still running after uninstall
title: "Uninstall"
x-i18n:
  source_hash: 6673a755c5e1f90a807dd8ac92a774cff6d1bc97d125c75e8bf72a40e952a777
---

# 제거

두 가지 경로:

- `openclaw`가 아직 설치되어 있는 경우 **쉬운 경로**입니다.
- **수동 서비스 제거** CLI가 사라졌지만 서비스가 계속 실행 중인 경우.

## 쉬운 경로(CLI는 여전히 설치되어 있음)

권장사항: 내장된 제거 프로그램을 사용하세요.

```bash
openclaw uninstall
```

비대화형(자동화/npx):

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

수동 단계(동일한 결과):

1. 게이트웨이 서비스를 중지합니다.

```bash
openclaw gateway stop
```

2. 게이트웨이 서비스(launchd/systemd/schtasks)를 제거합니다.

```bash
openclaw gateway uninstall
```

3. 상태 + 구성 삭제:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

`OPENCLAW_CONFIG_PATH`를 상태 디렉토리 외부의 사용자 정의 위치로 설정한 경우 해당 파일도 삭제하십시오.

4. 작업 영역을 삭제합니다(선택 사항, 에이전트 파일 제거).

```bash
rm -rf ~/.openclaw/workspace
```

5. CLI 설치를 제거합니다(사용한 것을 선택하십시오):

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

- 프로필(`--profile` / `OPENCLAW_PROFILE`)을 사용한 경우 각 상태 디렉터리에 대해 3단계를 반복합니다(기본값은 `~/.openclaw-<profile>`).
- 원격 모드에서는 상태 디렉토리가 **게이트웨이 호스트**에 있으므로 그곳에서도 1~4단계를 실행하세요.

## 수동 서비스 제거(CLI가 설치되지 않음)

게이트웨이 서비스가 계속 실행되고 있지만 `openclaw`가 누락된 경우 이 방법을 사용하세요.

### macOS(출시)

기본 레이블은 `bot.molt.gateway`입니다(또는 `bot.molt.<profile>`. 레거시 `com.openclaw.*`는 여전히 존재할 수 있습니다).

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

프로필을 사용한 경우 레이블과 plist 이름을 `bot.molt.<profile>`로 바꾸세요. 레거시 `com.openclaw.*` plist가 있는 경우 제거합니다.

### Linux(시스템 사용자 단위)

기본 장치 이름은 `openclaw-gateway.service`(또는 `openclaw-gateway-<profile>.service`)입니다.

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows(예약된 작업)

기본 작업 이름은 `OpenClaw Gateway`(또는 `OpenClaw Gateway (<profile>)`)입니다.
작업 스크립트는 상태 디렉토리 아래에 있습니다.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

프로필을 사용한 경우 일치하는 작업 이름과 `~\.openclaw-<profile>\gateway.cmd`를 삭제하세요.

## 일반 설치와 소스 체크아웃 비교

### 일반 설치(install.sh / npm / pnpm / bun)

`https://openclaw.ai/install.sh` 또는 `install.ps1`를 사용했다면 CLI는 `npm install -g openclaw@latest`로 설치되었습니다.
`npm rm -g openclaw`(또는 `pnpm remove -g` / `bun remove -g`로 설치한 경우)를 사용하여 제거합니다.

### 소스 체크아웃(git clone)

저장소 체크아웃에서 실행하는 경우 (`git clone` + `openclaw ...` / `bun run openclaw ...`):

1. 리포지토리를 삭제하기 전에 게이트웨이 서비스를 제거합니다(위의 쉬운 경로를 사용하거나 서비스를 수동으로 제거).
2. repo 디렉터리를 삭제합니다.
3. 위와 같이 상태 + 작업 공간을 제거합니다.
