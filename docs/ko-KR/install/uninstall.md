---
title: "제거"
summary: "OpenClaw 완전 제거 (CLI, 서비스, 상태, 작업 공간)"
read_when:
  - 머신에서 OpenClaw 를 제거하고 싶을 때
  - 제거 후에도 Gateway 서비스가 계속 실행될 때
x-i18n:
  source_path: docs/install/uninstall.md
---

# 제거

두 가지 경로:

- `openclaw` 이 아직 설치되어 있으면 **쉬운 경로**.
- CLI 가 없지만 서비스가 여전히 실행 중이면 **수동 서비스 제거**.

## 쉬운 경로 (CLI 가 아직 설치됨)

권장: 내장 제거 프로그램을 사용하세요:

```bash
openclaw uninstall
```

비대화형 (자동화 / npx):

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

수동 단계 (동일한 결과):

1. Gateway 서비스 중지:

```bash
openclaw gateway stop
```

2. Gateway 서비스 제거 (launchd/systemd/schtasks):

```bash
openclaw gateway uninstall
```

3. 상태 + 설정 삭제:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

`OPENCLAW_CONFIG_PATH` 를 상태 디렉토리 외부의 커스텀 위치로 설정한 경우 해당 파일도 삭제하세요.

4. 작업 공간 삭제 (선택 사항, 에이전트 파일 제거):

```bash
rm -rf ~/.openclaw/workspace
```

5. CLI 설치 제거 (사용한 것을 선택):

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

- 프로필 (`--profile` / `OPENCLAW_PROFILE`) 을 사용한 경우 각 상태 디렉토리에 대해 3 단계를 반복하세요 (기본값은 `~/.openclaw-<profile>`).
- 원격 모드에서는 상태 디렉토리가 **Gateway 호스트**에 있으므로 거기서도 1-4 단계를 실행하세요.

## 수동 서비스 제거 (CLI 미설치)

Gateway 서비스가 계속 실행되지만 `openclaw` 이 없을 때 사용합니다.

### macOS (launchd)

기본 레이블은 `ai.openclaw.gateway` (또는 `ai.openclaw.<profile>`; 레거시 `com.openclaw.*` 가 아직 존재할 수 있음) 입니다:

```bash
launchctl bootout gui/$UID/ai.openclaw.gateway
rm -f ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

프로필을 사용한 경우 레이블과 plist 이름을 `ai.openclaw.<profile>` 로 교체하세요. 존재하는 경우 레거시 `com.openclaw.*` plist 도 제거하세요.

### Linux (systemd 사용자 유닛)

기본 유닛 이름은 `openclaw-gateway.service` (또는 `openclaw-gateway-<profile>.service`) 입니다:

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (예약된 작업)

기본 작업 이름은 `OpenClaw Gateway` (또는 `OpenClaw Gateway (<profile>)`) 입니다.
작업 스크립트는 상태 디렉토리 아래에 있습니다.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

프로필을 사용한 경우 일치하는 작업 이름과 `~\.openclaw-<profile>\gateway.cmd` 를 삭제하세요.

## 일반 설치 vs 소스 체크아웃

### 일반 설치 (install.sh / npm / pnpm / bun)

`https://openclaw.ai/install.sh` 또는 `install.ps1` 을 사용한 경우 CLI 는 `npm install -g openclaw@latest` 로 설치되었습니다.
`npm rm -g openclaw` (또는 해당 방식으로 설치한 경우 `pnpm remove -g` / `bun remove -g`) 로 제거하세요.

### 소스 체크아웃 (git clone)

저장소 체크아웃 (`git clone` + `openclaw ...` / `bun run openclaw ...`) 에서 실행하는 경우:

1. 저장소를 삭제하기 **전에** Gateway 서비스를 제거하세요 (위의 쉬운 경로 또는 수동 서비스 제거를 사용).
2. 저장소 디렉토리를 삭제합니다.
3. 위에 표시된 대로 상태 + 작업 공간을 제거합니다.
