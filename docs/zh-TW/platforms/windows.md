---
summary: "Windows (WSL2) 支援 + 配套應用狀態"
read_when:
  - 在 Windows 上安裝 OpenClaw
  - 查詢 Windows 配套應用狀態
title: "Windows (WSL2)"
---

# Windows (WSL2)

OpenClaw 在 Windows 上建議**透過 WSL2**（建議使用 Ubuntu）。CLI + Gateway 在 Linux 內部執行，這使得執行期保持一致，並使工具（Node/Bun/pnpm、Linux 二進位檔、Skills）的相容性更高。原生 Windows 可能會比較棘手。WSL2 讓您擁有完整的 Linux 體驗——一個指令即可安裝：`wsl --install`。

原生 Windows 配套應用正在規劃中。

## 安裝 (WSL2)

- [入門指南](/start/getting-started) (在 WSL 內部使用)
- [安裝與更新](/install/updating)
- 官方 WSL2 指南 (Microsoft)：[https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Gateway 執行手冊](/gateway)
- [設定](/gateway/configuration)

## Gateway 服務安裝 (CLI)

在 WSL2 內部：

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

提示時，請選擇 **Gateway 服務**。

修復/遷移：

```
openclaw doctor
```

## 進階：透過區域網路公開 WSL 服務 (portproxy)

WSL 有其自己的虛擬網路。如果另一台機器需要存取在 **WSL 內部**執行的服務（SSH、本機 TTS 伺服器或 Gateway），您必須將 Windows 連接埠轉發到目前的 WSL IP。WSL IP 在重新啟動後會變更，因此您可能需要重新整理轉發規則。

範例 (以**管理員身份**執行的 PowerShell)：

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

允許連接埠通過 Windows 防火牆（一次性）：

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

WSL 重新啟動後重新整理 portproxy：

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

注意事項：

- 來自另一台機器的 SSH 目標是 **Windows 主機 IP**（範例：`ssh user @windows-host -p 2222`）。
- 遠端節點必須指向**可連線的** Gateway URL（不是 `127.0.0.1`）；使用 `openclaw status --all` 來確認。
- 使用 `listenaddress=0.0.0.0` 進行區域網路存取；`127.0.0.1` 則僅限本機使用。
- 如果您希望自動執行此操作，請註冊一個排定的工作，以便在登入時執行重新整理步驟。

## 逐步 WSL2 安裝

### 1) 安裝 WSL2 + Ubuntu

開啟 PowerShell (管理員權限)：

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

如果 Windows 要求，請重新啟動。

### 2) 啟用 systemd (Gateway 安裝必需)

在您的 WSL 終端機中：

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

然後從 PowerShell：

```powershell
wsl --shutdown
```

重新開啟 Ubuntu，然後驗證：

```bash
systemctl --user status
```

### 3) 安裝 OpenClaw (在 WSL 內部)

在 WSL 內部遵循 Linux 入門指南流程：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

完整指南：[入門指南](/start/getting-started)

## Windows 配套應用

我們尚未提供 Windows 配套應用。如果您願意貢獻以促成此事，歡迎提供協助。
