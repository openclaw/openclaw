---
summary: "Windows（WSL2）支援與配套應用程式狀態"
read_when:
  - 在 Windows 上安裝 OpenClaw
  - 尋找 Windows 配套應用程式狀態
title: "Windows（WSL2）"
x-i18n:
  source_path: platforms/windows.md
  source_hash: d17df1bd5636502e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:59Z
---

# Windows（WSL2）

在 Windows 上使用 OpenClaw **建議透過 WSL2**（建議使用 Ubuntu）。CLI 與 Gateway 閘道器 會在 Linux 內執行，這能保持執行環境一致，並讓工具鏈具有更高的相容性（Node/Bun/pnpm、Linux 二進位檔、skills）。原生 Windows 可能會比較棘手。WSL2 可提供完整的 Linux 體驗——只需一個指令即可安裝：`wsl --install`。

原生 Windows 配套應用程式已列入規劃中。

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

WSL 有自己的虛擬網路。若另一台機器需要連線到**在 WSL 內**執行的服務（SSH、本機 TTS 伺服器，或 Gateway 閘道器），你必須將 Windows 連接埠轉送到目前的 WSL IP。WSL IP 會在重新啟動後變更，因此你可能需要重新整理轉送規則。

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
- 若希望自動化，可註冊一個排程工作，在登入時執行重新整理步驟。

## WSL2 逐步安裝

### 1) 安裝 WSL2 + Ubuntu

開啟 PowerShell（系統管理員）：

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

若 Windows 要求，請重新啟動。

### 2) 啟用 systemd（安裝 Gateway 閘道器 所需）

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

### 3) 安裝 OpenClaw（在 WSL 內）

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

目前尚未提供 Windows 配套應用程式。若你有興趣協助實現，歡迎貢獻。
