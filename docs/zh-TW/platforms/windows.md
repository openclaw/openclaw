---
summary: "Windows (WSL2) 支援 + 配套應用狀態"
read_when:
  - 在 Windows 上安裝 OpenClaw
  - 尋找 Windows 配套應用狀態
title: "Windows (WSL2)"
---

# Windows (WSL2)

建議透過 **WSL2**（推薦使用 Ubuntu）在 Windows 上執行 OpenClaw。
CLI + Gateway 會在 Linux 內部執行，這能保持執行環境的一致性，並使工具鏈的相容性更高（如 Node/Bun/pnpm、Linux 執行檔、Skills）。原生 Windows 可能會比較棘手。WSL2 提供完整的 Linux 體驗 —— 只需一個指令即可安裝：`wsl --install`。

原生 Windows 的配套應用正在計劃中。

## 安裝 (WSL2)

- [入門指南](/start/getting-started) (在 WSL 內使用)
- [安裝與更新](/install/updating)
- 官方 WSL2 指南 (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Gateway 執行手冊](/gateway)
- [設定](/gateway/configuration)

## 安裝 Gateway 服務 (CLI)

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

修復/遷移：

```
openclaw doctor
```

## 進階：透過區域網路 (LAN) 公開 WSL 服務 (portproxy)

WSL 有自己的虛擬網路。如果其他裝置需要存取執行於 **WSL 內部** 的服務（如 SSH、本地 TTS 伺服器或 Gateway），你必須將 Windows 的連接埠轉發到目前的 WSL IP。WSL IP 在重啟後會變更，因此你可能需要更新轉發規則。

範例 (以 **系統管理員身分** 執行 PowerShell):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

允許通過 Windows 防火牆 (僅需一次)：

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

WSL 重啟後重新整理 portproxy：

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

備註：

- 來自其他裝置的 SSH 連線目標為 **Windows 主機 IP**（例如：`ssh user@windows-host -p 2222`）。
- 遠端節點必須指向 **可存取** 的 Gateway URL（而非 `127.0.0.1`）；請使用 `openclaw status --all` 確認。
- 使用 `listenaddress=0.0.0.0` 以供區域網路存取；`127.0.0.1` 則僅限本地使用。
- 如果你希望自動化，請註冊一個「工作排程器」任務，在登入時執行重新整理步驟。

## WSL2 安裝步驟

### 1) 安裝 WSL2 + Ubuntu

開啟 PowerShell (系統管理員)：

```powershell
wsl --install
# 或明確選擇一個發行版：
wsl --list --online
wsl --install -d Ubuntu-24.04
```

如果 Windows 要求，請重新啟動。

### 2) 啟用 systemd (安裝 Gateway 時必要)

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

重新開啟 Ubuntu 並進行驗證：

```bash
systemctl --user status
```

### 3) 安裝 OpenClaw (在 WSL 內)

在 WSL 內遵循 Linux 的入門指南流程：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # 首次執行時會自動安裝 UI 依賴項目
pnpm build
openclaw onboard
```

完整指南：[入門指南](/start/getting-started)

## Windows 配套應用

我們目前還沒有 Windows 配套應用。如果你想協助開發，歡迎提交貢獻。
