---
summary: "OpenClaw 를 완전히 제거합니다 (CLI, 서비스, 상태, 워크스페이스)"
read_when:
  - 기계에서 OpenClaw 를 제거하려고 할 때
  - 제거 후 Gateway 서비스가 여전히 실행 중일 때
title: "제거"
---

# 제거

두 가지 경로:

- **쉬운 경로** if `openclaw` 여전히 설치된 경우.
- **수동 서비스 제거** CLI 가 없지만 서비스가 여전히 실행 중인 경우.

## 쉬운 경로 (CLI 여전히 설치됨)

권장: 기본 제거자 사용:

```bash
openclaw uninstall
```

비대화형 (자동화 / npx):

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

## 수동 서비스 제거 (CLI 설치되지 않음)

Gateway 서비스가 계속 실행되지만 `openclaw` 누락되는 경우 사용합니다.

### macOS (launchd)

기본 라벨은 `ai.openclaw.gateway` (또는 `ai.openclaw.<profile>`; 레거시 `com.openclaw.*` 여전히 존재할 수 있음):

```bash
launchctl bootout gui/$UID/ai.openclaw.gateway
rm -f ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

프로필을 사용한 경우 라벨 및 plist 이름을 `ai.openclaw.<profile>` 로 바꿉니다. 있으면 모든 레거시 `com.openclaw.*` plist 를 제거합니다.

### Linux (systemd 사용자 단위)

기본 단위 이름은 `openclaw-gateway.service` (또는 `openclaw-gateway-<profile>.service`):

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (Scheduled Task)

기본 작업 이름은 `OpenClaw Gateway` (또는 `OpenClaw Gateway (<profile>)`). 작업 스크립트는 상태 디렉토리 아래에 있습니다.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

프로필을 사용한 경우 일치하는 작업 이름 및 `~\.openclaw-<profile>\gateway.cmd` 를 삭제합니다.

## 정상 설치 vs 소스 체크아웃

### 정상 설치 (install.sh / npm / pnpm / bun)

`https://openclaw.ai/install.sh` 또는 `install.ps1` 을 사용한 경우 CLI 는 `npm install -g openclaw@latest` 로 설치되었습니다.
`npm rm -g openclaw` 로 제거합니다 (또는 `pnpm remove -g` / `bun remove -g` 설치한 경우).

### 소스 체크아웃 (git clone)

리포지토리 체크아웃에서 실행하는 경우 (`git clone` + `openclaw ...` / `bun run openclaw ...`):

1. 리포지토리를 삭제하기 전에 Gateway 서비스를 제거합니다 (위의 쉬운 경로 사용 또는 수동 서비스 제거).
2. 리포지토리 디렉토리를 삭제합니다.
3. 위에 표시된 대로 상태 + 워크스페이스를 제거합니다.

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/install/uninstall.md
workflow: 15
