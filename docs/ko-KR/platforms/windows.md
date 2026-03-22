---
summary: "Windows 지원: 네이티브 및 WSL2 설치 경로, 데몬, 현재 주의사항"
read_when:
  - Windows 에 OpenClaw 을 설치할 때
  - 네이티브 Windows 와 WSL2 중 선택할 때
  - Windows 동반 앱 상태를 확인할 때
title: "Windows"
x-i18n:
  source_path: docs/platforms/windows.md
---

# Windows

OpenClaw 은 **네이티브 Windows** 와 **WSL2** 를 모두 지원합니다. WSL2 가 더
안정적인 경로이며 완전한 경험을 위해 권장됩니다 -- CLI, Gateway, 도구가
완전한 호환성으로 Linux 내에서 실행됩니다. 네이티브 Windows 는
핵심 CLI 및 Gateway 사용이 가능하지만, 아래에 명시된 일부 주의사항이 있습니다.

네이티브 Windows 동반 앱은 계획 중입니다.

## WSL2 (권장)

- [시작하기](/start/getting-started) (WSL 내에서 사용)
- [설치 및 업데이트](/install/updating)
- 공식 WSL2 가이드 (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## 네이티브 Windows 상태

네이티브 Windows CLI 흐름은 개선 중이지만, WSL2 가 여전히 권장 경로입니다.

현재 네이티브 Windows 에서 잘 작동하는 기능:

- `install.ps1` 을 통한 웹사이트 설치
- `openclaw --version`, `openclaw doctor`, `openclaw plugins list --json` 등 로컬 CLI 사용
- 다음과 같은 내장 로컬 에이전트/프로바이더 스모크 테스트:

```powershell
openclaw agent --local --agent main --thinking low -m "Reply with exactly WINDOWS-HATCH-OK."
```

현재 주의사항:

- `openclaw onboard --non-interactive` 는 `--skip-health` 를 전달하지 않으면 여전히 접근 가능한 로컬 Gateway 를 요구합니다
- `openclaw onboard --non-interactive --install-daemon` 과 `openclaw gateway install` 은 먼저 Windows 예약된 작업을 시도합니다
- 예약된 작업 생성이 거부되면, OpenClaw 은 사용자별 시작 폴더 로그인 항목으로 폴백하고 즉시 Gateway 를 시작합니다
- `schtasks` 자체가 멈추거나 응답을 중지하면, OpenClaw 은 해당 경로를 빠르게 중단하고 영원히 대기하는 대신 폴백합니다
- 예약된 작업이 사용 가능할 때 여전히 선호되는 이유는 더 나은 슈퍼바이저 상태를 제공하기 때문입니다

Gateway 서비스 설치 없이 네이티브 CLI 만 원한다면 다음 중 하나를 사용하세요:

```powershell
openclaw onboard --non-interactive --skip-health
openclaw gateway run
```

네이티브 Windows 에서 관리되는 시작을 원한다면:

```powershell
openclaw gateway install
openclaw gateway status --json
```

예약된 작업 생성이 차단되면, 폴백 서비스 모드가 현재 사용자의 시작 폴더를 통해 로그인 후 자동 시작됩니다.

## Gateway

- [Gateway 운영 가이드](/gateway)
- [설정](/gateway/configuration)

## Gateway 서비스 설치 (CLI)

WSL2 내부:

```
openclaw onboard --install-daemon
```

또는:

```
openclaw gateway install
```

또는:

```
openclaw configure
```

프롬프트가 나타나면 **Gateway service** 를 선택하세요.

복구/마이그레이션:

```
openclaw doctor
```

## Windows 로그인 전 Gateway 자동 시작

헤드리스 설정의 경우, 아무도 Windows 에 로그인하지 않아도 전체 부팅 체인이
실행되도록 하세요.

### 1) 로그인 없이 사용자 서비스 유지

WSL 내부:

```bash
sudo loginctl enable-linger "$(whoami)"
```

### 2) OpenClaw Gateway 사용자 서비스 설치

WSL 내부:

```bash
openclaw gateway install
```

### 3) Windows 부팅 시 WSL 자동 시작

관리자 권한으로 PowerShell 에서:

```powershell
schtasks /create /tn "WSL Boot" /tr "wsl.exe -d Ubuntu --exec /bin/true" /sc onstart /ru SYSTEM
```

`Ubuntu` 를 다음 명령에서 확인한 배포판 이름으로 교체하세요:

```powershell
wsl --list --verbose
```

### 시작 체인 확인

재부팅 후 (Windows 로그인 전), WSL 에서 확인하세요:

```bash
systemctl --user is-enabled openclaw-gateway
systemctl --user status openclaw-gateway --no-pager
```

## 고급: LAN 을 통한 WSL 서비스 노출 (portproxy)

WSL 은 자체 가상 네트워크를 가지고 있습니다. 다른 머신이 **WSL 내부**에서
실행 중인 서비스 (SSH, 로컬 TTS 서버, 또는 Gateway) 에 접근해야 하는 경우,
Windows 포트를 현재 WSL IP 로 포워딩해야 합니다. WSL IP 는 재시작 후 변경되므로
포워딩 규칙을 새로 고쳐야 할 수 있습니다.

예시 (**관리자 권한으로** PowerShell):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Windows 방화벽을 통해 포트 허용 (1 회):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

WSL 재시작 후 portproxy 새로 고침:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

참고:

- 다른 머신에서의 SSH 는 **Windows 호스트 IP** 를 대상으로 합니다 (예: `ssh user@windows-host -p 2222`).
- 원격 노드는 **접근 가능한** Gateway URL 을 가리켜야 합니다 (`127.0.0.1` 이 아님);
  `openclaw status --all` 로 확인하세요.
- LAN 접근에는 `listenaddress=0.0.0.0` 을 사용하세요; `127.0.0.1` 은 로컬 전용입니다.
- 자동화가 필요하면 로그인 시 새로 고침 단계를 실행하는 예약된 작업을 등록하세요.

## WSL2 단계별 설치

### 1) WSL2 + Ubuntu 설치

PowerShell (관리자) 을 엽니다:

```powershell
wsl --install
# 또는 배포판을 명시적으로 선택:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Windows 가 요청하면 재부팅하세요.

### 2) systemd 활성화 (Gateway 설치에 필요)

WSL 터미널에서:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

그런 다음 PowerShell 에서:

```powershell
wsl --shutdown
```

Ubuntu 를 다시 열고 확인합니다:

```bash
systemctl --user status
```

### 3) OpenClaw 설치 (WSL 내부)

WSL 내에서 Linux 시작하기 흐름을 따르세요:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # 첫 실행 시 UI 의존성을 자동 설치
pnpm build
openclaw onboard
```

전체 가이드: [시작하기](/start/getting-started)

## Windows 동반 앱

아직 Windows 동반 앱이 없습니다. 만들고 싶으시다면
기여를 환영합니다.
