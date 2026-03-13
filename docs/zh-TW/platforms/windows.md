---
summary: Windows (WSL2) support + companion app status
read_when:
  - Installing OpenClaw on Windows
  - Looking for Windows companion app status
title: Windows (WSL2)
---

# Windows (WSL2)

建議在 Windows 上透過 **WSL2**（推薦使用 Ubuntu）來使用 OpenClaw。CLI 與 Gateway 都在 Linux 環境中執行，這樣可以保持執行環境的一致性，並讓工具鏈更相容（Node/Bun/pnpm、Linux 二進位檔、技能）。原生 Windows 可能會比較麻煩。WSL2 提供完整的 Linux 體驗 — 安裝只需一行指令：`wsl --install`。

原生 Windows 的輔助應用程式正在規劃中。

## 安裝（WSL2）

- [快速開始](/start/getting-started)（在 WSL 內使用）
- [安裝與更新](/install/updating)
- 官方 WSL2 指南（微軟）：[https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## 原生 Windows 狀態

原生 Windows CLI 流程正在改善中，但仍建議使用 WSL2。

目前在原生 Windows 上運作良好的專案：

- 透過 `install.ps1` 的網站安裝程式
- 本地 CLI 使用，如 `openclaw --version`、`openclaw doctor` 和 `openclaw plugins list --json`
- 嵌入式本地代理/提供者的簡易測試，如：

```powershell
openclaw agent --local --agent main --thinking low -m "Reply with exactly WINDOWS-HATCH-OK."
```

目前的注意事項：

- `openclaw onboard --non-interactive` 仍然預期有可連線的本地 gateway，除非你傳入 `--skip-health`
- `openclaw onboard --non-interactive --install-daemon` 和 `openclaw gateway install` 目前使用 Windows 排程任務
- 在某些原生 Windows 環境中，安裝排程任務可能需要以系統管理員身份執行 PowerShell

如果你只想要原生 CLI，不安裝 gateway 服務，可以使用以下其中一個：

```powershell
openclaw onboard --non-interactive --skip-health
openclaw gateway run
```

## Gateway

- [Gateway 運維手冊](/gateway)
- [設定](/gateway/configuration)

## Gateway 服務安裝（CLI）

在 WSL2 內：

```
openclaw onboard --install-daemon
```

或者：

```
openclaw gateway install
```

或者：

```
openclaw configure
```

當系統提示時，選擇 **Gateway 服務**。

修復/遷移：

```
openclaw doctor
```

## Gateway 在 Windows 登入前自動啟動

針對無頭（headless）環境，確保即使沒有人登入 Windows，完整的啟動流程仍能執行。

### 1) 無需登入即可保持使用者服務執行

在 WSL 內：

```bash
sudo loginctl enable-linger "$(whoami)"
```

### 2) 安裝 OpenClaw gateway 使用者服務

在 WSL 內：

```bash
openclaw gateway install
```

### 3) 設定 WSL 開機自動啟動

以系統管理員身份開啟 PowerShell：

```powershell
schtasks /create /tn "WSL Boot" /tr "wsl.exe -d Ubuntu --exec /bin/true" /sc onstart /ru SYSTEM
```

將 `Ubuntu` 替換成你的發行版名稱，名稱可從以下查詢：

```powershell
wsl --list --verbose
```

### 驗證啟動流程

重新開機後（Windows 登入前），在 WSL 中檢查：

```bash
systemctl --user is-enabled openclaw-gateway
systemctl --user status openclaw-gateway --no-pager
```

## 進階：透過區域網路暴露 WSL 服務（portproxy）

WSL 有自己的虛擬網路。如果其他電腦需要連接
**WSL 內部**執行的服務（如 SSH、本地 TTS 伺服器或 Gateway），
必須將 Windows 的埠轉發到目前的 WSL IP。WSL IP 會在重啟後改變，
因此可能需要重新設定轉發規則。

範例（以系統管理員身份執行 PowerShell）：

powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "找不到 WSL IP。" }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort 
  connectaddress=$WslIp connectport=$TargetPort

允許此埠通過 Windows 防火牆（一次性設定）：

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

WSL 重啟後，重新整理 portproxy：

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

注意事項：

- 從其他機器 SSH 時，目標為 **Windows 主機 IP**（範例：`ssh user@windows-host -p 2222`）。
- 遠端節點必須指向 **可連線的** Gateway URL（非 `127.0.0.1`）；可用 `openclaw status --all` 來確認。
- 使用 `listenaddress=0.0.0.0` 以取得區域網路存取；`127.0.0.1` 則限制為本機存取。
- 若想自動化，請註冊排程任務，在登入時執行重新整理步驟。

## WSL2 安裝步驟說明

### 1) 安裝 WSL2 與 Ubuntu

以系統管理員身份開啟 PowerShell：

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

若 Windows 要求，請重新啟動。

### 2) 啟用 systemd（Gateway 安裝所需）

在你的 WSL 終端機中：

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

接著從 PowerShell 執行：

```powershell
wsl --shutdown
```

重新開啟 Ubuntu，然後驗證：

```bash
systemctl --user status
```

### 3) 安裝 OpenClaw（在 WSL 內）

在 WSL 內依照 Linux 入門流程操作：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

完整指南：[入門指南](/start/getting-started)

## Windows 伴隨應用程式

我們目前尚無 Windows 伴隨應用程式。如果你願意貢獻，歡迎協助開發。
