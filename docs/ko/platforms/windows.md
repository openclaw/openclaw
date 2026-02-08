---
read_when:
    - Windows에 OpenClaw 설치
    - Windows 도우미 앱 상태를 찾고 있습니다.
summary: Windows(WSL2) 지원 + 도우미 앱 상태
title: 윈도우(WSL2)
x-i18n:
    generated_at: "2026-02-08T16:05:10Z"
    model: gtx
    provider: google-translate
    source_hash: d17df1bd5636502e45697526758648520ab1d7aa04356748695bfbe572005ebd
    source_path: platforms/windows.md
    workflow: 15
---

# 윈도우(WSL2)

Windows에서는 OpenClaw를 권장합니다. **WSL2를 통해** (우분투 권장). 는
CLI + 게이트웨이는 Linux 내에서 실행되어 런타임의 일관성을 유지하고
훨씬 더 호환되는 도구입니다(Node/Bun/pnpm, Linux 바이너리, 기술). 네이티브
Windows가 더 까다로울 수 있습니다. WSL2는 완전한 Linux 환경을 제공합니다. 단 하나의 명령
설치하려면: `wsl --install`.

기본 Windows 도우미 앱이 계획되어 있습니다.

## 설치(WSL2)

- [시작하기](/start/getting-started) (WSL 내부에서 사용)
- [설치 및 업데이트](/install/updating)
- 공식 WSL2 가이드(Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## 게이트웨이

- [게이트웨이 런북](/gateway)
- [구성](/gateway/configuration)

## 게이트웨이 서비스 설치(CLI)

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

선택하다 **게이트웨이 서비스** 메시지가 표시되면.

복구/마이그레이션:

```
openclaw doctor
```

## 고급: LAN(포트프록시)을 통해 WSL 서비스 노출

WSL에는 자체 가상 네트워크가 있습니다. 다른 기계가 서비스를 받아야 하는 경우
달리기 **WSL 내부** (SSH, 로컬 TTS 서버 또는 게이트웨이)
Windows 포트를 현재 WSL IP로 전달합니다. 다시 시작한 후 WSL IP가 변경됩니다.
따라서 전달 규칙을 새로 고쳐야 할 수도 있습니다.

예(PowerShell **관리자로서**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Windows 방화벽을 통해 포트 허용(1회):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

WSL이 다시 시작된 후 포트 프록시를 새로 고칩니다.

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

참고:

- 다른 시스템의 SSH는 다음을 대상으로 합니다. **Windows 호스트 IP** (예: `ssh user@windows-host -p 2222`).
- 원격 노드는 다음을 가리켜야 합니다. **도달 가능** 게이트웨이 URL(아님 `127.0.0.1`); 사용
  `openclaw status --all` 확인하기 위해.
- 사용 `listenaddress=0.0.0.0` LAN 액세스용; `127.0.0.1` 로컬에만 유지합니다.
- 이 작업을 자동으로 수행하려면 예약된 작업을 등록하여 새로 고침을 실행하세요.
  로그인 단계.

## 단계별 WSL2 설치

### 1) WSL2 + 우분투 설치

PowerShell 열기(관리자):

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Windows에서 요청하면 재부팅합니다.

### 2) systemd 활성화(게이트웨이 설치에 필요)

WSL 터미널에서:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

그런 다음 PowerShell에서 다음을 수행합니다.

```powershell
wsl --shutdown
```

Ubuntu를 다시 열고 다음을 확인합니다.

```bash
systemctl --user status
```

### 3) OpenClaw 설치(WSL 내부)

WSL 내에서 Linux 시작하기 흐름을 따르세요.

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

전체 가이드: [시작하기](/start/getting-started)

## Windows 도우미 앱

아직 Windows 도우미 앱이 없습니다. 원한다면 기여를 환영합니다
실현할 수 있도록 기여합니다.
