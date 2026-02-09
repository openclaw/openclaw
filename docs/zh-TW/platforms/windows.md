---
summary: "Windows（WSL2）支援與配套應用程式狀態"
read_when:
  - 在 Windows 上安裝 OpenClaw
  - Looking for Windows companion app status
title: "Windows（WSL2）"
---

# Windows（WSL2）

OpenClaw on Windows is recommended **via WSL2** (Ubuntu recommended). The
CLI + Gateway run inside Linux, which keeps the runtime consistent and makes
tooling far more compatible (Node/Bun/pnpm, Linux binaries, skills). Native
Windows might be trickier. WSL2 gives you the full Linux experience — one command
to install: `wsl --install`.

已規劃原生 Windows 夥伴應用程式。

## 安裝（WSL2）

- [入門指南](/start/getting-started)（請在 WSL 內使用）
- [安裝與更新](/install/updating)
- 官方 WSL2 指南（Microsoft）：[https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Gateway 操作手冊](/gateway)
- [設定](/gateway/configuration)

## Gateway 服務安裝（CLI）

在 WSL2 內：

```
openclaw onboard --install-daemon
```

或：

```
openclaw gateway install
```

或：

```
openclaw configure
```

出現提示時選擇 **Gateway service**。

修復／遷移：

```
openclaw doctor
```

## 進階：透過 LAN 公開 WSL 服務（portproxy）

WSL 有其自己的虛擬網路。 如果另一台機器需要存取
在 **WSL 內部** 執行的服務（SSH、本機 TTS 伺服器或 Gateway），你必須將 Windows 連接埠轉送到目前的 WSL IP。 The WSL IP changes after restarts,
so you may need to refresh the forwarding rule.

範例（PowerShell **以系統管理員身分**）：

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

允許該連接埠通過 Windows 防火牆（一次性）：

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

在 WSL 重新啟動後重新整理 portproxy：

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

注意事項：

- 從另一台機器進行 SSH 時，目標為 **Windows 主機 IP**（例如：`ssh user@windows-host -p 2222`）。
- 遠端節點必須指向**可到達的** Gateway 閘道器 URL（不是 `127.0.0.1`）；請使用
  `openclaw status --all` 進行確認。
- 使用 `listenaddress=0.0.0.0` 以供 LAN 存取；`127.0.0.1` 則僅限本機。
- If you want this automatic, register a Scheduled Task to run the refresh
  step at login.

## WSL2 逐步安裝

### 1. 安裝 WSL2 + Ubuntu

開啟 PowerShell（系統管理員）：

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

若 Windows 要求，請重新啟動。

### 2. 啟用 systemd（安裝 Gateway 閘道器 所需）

在你的 WSL 終端機中：

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

接著在 PowerShell 中：

```powershell
wsl --shutdown
```

重新開啟 Ubuntu，然後驗證：

```bash
systemctl --user status
```

### 3. 安裝 OpenClaw（在 WSL 內）

在 WSL 內依照 Linux 的入門指南流程操作：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

完整指南：[入門指南](/start/getting-started)

## Windows 配套應用程式

We do not have a Windows companion app yet. Contributions are welcome if you want
contributions to make it happen.
