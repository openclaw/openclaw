---
summary: "Windows (WSL2) 지원 + 동반 앱 상태"
read_when:
  - Windows 에 OpenClaw 를 설치할 때
  - Windows 동반 앱 상태를 찾을 때
title: "Windows (WSL2)"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: platforms/windows.md
  workflow: 15
---

# Windows (WSL2)

Windows 의 OpenClaw 는 **WSL2 를 통해** (Ubuntu 권장) 권장됩니다. CLI + Gateway 는 Linux 내부에서 실행되므로 런타임이 일관성 있게 유지되고 도구 호환성 (Node/Bun/pnpm, Linux 바이너리, Skills) 이 훨씬 더 나습니다. 네이티브 Windows 는 더 까다로울 수 있습니다. WSL2 는 전체 Linux 환경을 제공합니다 — 설치 한 명령: `wsl --install`.

네이티브 Windows 동반 앱이 계획되어 있습니다.

## 설치 (WSL2)

- [시작하기](/start/getting-started) (WSL 내부에서 사용)
- [설치 & 업데이트](/install/updating)
- 공식 WSL2 가이드 (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Gateway 실행 가이드](/ko-KR/gateway)
- [구성](/ko-KR/gateway/configuration)

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

프롬프트가 나타나면 **Gateway 서비스** 를 선택합니다.

복구/마이그레이션:

```
openclaw doctor
```

## 고급: WSL 서비스를 LAN 전체에 노출 (portproxy)

WSL 은 자체 가상 네트워크를 가집니다. 다른 머신이 **WSL 내부** (SSH, 로컬 TTS 서버 또는 Gateway) 에서 실행 중인 서비스에 연결해야 하는 경우 Windows 포트를 현재 WSL IP 로 전달해야 합니다. WSL IP 는 재시작 후 변경되므로 전달 규칙을 새로 고쳐야 할 수도 있습니다.

예 (PowerShell **관리자로**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Windows Firewall 을 통해 포트를 허용합니다 (일회성):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

WSL 재시작 후 portproxy 를 새로 고칩니다:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

참고:

- 다른 머신에서 SSH 는 **Windows 호스트 IP** 를 대상으로 합니다 (예: `ssh user@windows-host -p 2222`).
- 원격 노드는 **도달 가능한** Gateway URL 을 가리켜야 합니다 (`127.0.0.1` 아님); `openclaw status --all` 로 확인합니다.
- LAN 액세스의 경우 `listenaddress=0.0.0.0` 을 사용합니다; `127.0.0.1` 은 로컬로만 유지합니다.
- 자동화하려면 로그인 시 새로 고침 단계를 실행하도록 Scheduled Task 를 등록합니다.

## 단계별 WSL2 설치

### 1) WSL2 + Ubuntu 설치

PowerShell (Admin) 을 엽니다:

```powershell
wsl --install
# 또는 명시적으로 Distro 를 선택:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Windows 가 요청하면 재부팅합니다.

### 2) systemd 활성화 (Gateway 설치에 필요)

WSL 터미널에서:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

그러면 PowerShell 에서:

```powershell
wsl --shutdown
```

Ubuntu 를 다시 열고 확인합니다:

```bash
systemctl --user status
```

### 3) OpenClaw 설치 (WSL 내부)

WSL 내부에서 Linux Getting Started 흐름을 따릅니다:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # 첫 실행에서 자동으로 UI deps 설치
pnpm build
openclaw onboard
```

전체 가이드: [시작하기](/start/getting-started)

## Windows 동반 앱

아직 Windows 동반 앱이 없습니다. 그것을 실현하는 데 도움을 주고 싶다면 기여를 환영합니다.
