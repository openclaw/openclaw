---
read_when:
    - 기계에서 OpenClaw를 제거하고 싶습니다.
    - 제거 후에도 게이트웨이 서비스가 계속 실행 중입니다.
summary: OpenClaw를 완전히 제거합니다(CLI, 서비스, 상태, 작업 공간).
title: 제거
x-i18n:
    generated_at: "2026-02-08T16:02:27Z"
    model: gtx
    provider: google-translate
    source_hash: 6673a755c5e1f90a807dd8ac92a774cff6d1bc97d125c75e8bf72a40e952a777
    source_path: install/uninstall.md
    workflow: 15
---

# 제거

두 가지 경로:

- **쉬운 길** 만약에 `openclaw` 아직 설치되어 있습니다.
- **수동 서비스 제거** CLI가 사라졌지만 서비스가 계속 실행 중인 경우

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

설정하면 `OPENCLAW_CONFIG_PATH` 상태 디렉토리 외부의 사용자 정의 위치로 이동하려면 해당 파일도 삭제하십시오.

4. 작업공간을 삭제합니다(선택사항, 에이전트 파일 제거).

```bash
rm -rf ~/.openclaw/workspace
```

5. CLI 설치를 제거합니다(사용한 것을 선택하세요):

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

- 프로필(`--profile` / `OPENCLAW_PROFILE`), 각 상태 디렉토리에 대해 3단계를 반복합니다(기본값은 다음과 같습니다). `~/.openclaw-<profile>`).
- 원격 모드에서 상태 디렉토리는 **게이트웨이 호스트**, 따라서 거기에서도 1~4단계를 실행하세요.

## 수동 서비스 제거(CLI가 설치되지 않음)

게이트웨이 서비스가 계속 실행되지만 `openclaw` 누락되었습니다.

### macOS(출시)

기본 라벨은 다음과 같습니다. `bot.molt.gateway` (또는 `bot.molt.<profile>`; 유산 `com.openclaw.*` 아직 존재할 수 있음):

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

프로필을 사용한 경우 라벨과 plist 이름을 다음으로 바꾸세요. `bot.molt.<profile>`. 레거시 제거 `com.openclaw.*` 존재하는 경우 plists입니다.

### Linux(시스템 사용자 단위)

기본 단위 이름은 다음과 같습니다. `openclaw-gateway.service` (또는 `openclaw-gateway-<profile>.service`):

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows(예약된 작업)

기본 작업 이름은 다음과 같습니다. `OpenClaw Gateway` (또는 `OpenClaw Gateway (<profile>)`).
작업 스크립트는 상태 디렉토리 아래에 있습니다.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

프로필을 사용한 경우 일치하는 작업 이름을 삭제하고 `~\.openclaw-<profile>\gateway.cmd`.

## 일반 설치 및 소스 체크아웃

### 일반 설치(install.sh / npm / pnpm / bun)

사용한 경우 `https://openclaw.ai/install.sh` 또는 `install.ps1`, CLI는 다음과 같이 설치되었습니다. `npm install -g openclaw@latest`.
그것을 제거하십시오 `npm rm -g openclaw` (또는 `pnpm remove -g` / `bun remove -g` 그런 식으로 설치한 경우).

### 소스 체크아웃(git clone)

저장소 체크아웃(`git clone` + `openclaw ...` / `bun run openclaw ...`):

1. 게이트웨이 서비스 제거 **~ 전에** 저장소 삭제(위의 쉬운 경로 사용 또는 수동 서비스 제거 사용)
2. repo 디렉터리를 삭제합니다.
3. 위와 같이 상태 + 작업 공간을 제거하십시오.
