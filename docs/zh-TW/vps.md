---
summary: VPS hosting hub for OpenClaw (Oracle/Fly/Hetzner/GCP/exe.dev)
read_when:
  - You want to run the Gateway in the cloud
  - You need a quick map of VPS/hosting guides
title: VPS Hosting
---

# VPS 主機托管

此中心連結至支援的 VPS/主機托管指南，並以高階角度說明雲端部署的運作方式。

## 選擇供應商

- **Railway**（一鍵安裝 + 瀏覽器設定）：[Railway](/install/railway)
- **Northflank**（一鍵安裝 + 瀏覽器設定）：[Northflank](/install/northflank)
- **Oracle Cloud（永遠免費）**：[Oracle](/platforms/oracle) — $0/月（永遠免費，ARM 架構；容量與註冊可能較為複雜）
- **Fly.io**：[Fly.io](/install/fly)
- **Hetzner（Docker）**：[Hetzner](/install/hetzner)
- **GCP（Compute Engine）**：[GCP](/install/gcp)
- **exe.dev**（虛擬機 + HTTPS 代理）：[exe.dev](/install/exe-dev)
- **AWS（EC2/Lightsail/免費方案）**：也相當好用。影片教學：
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## 雲端架構運作方式

- **Gateway 執行於 VPS**，並管理狀態與工作區。
- 你可透過 **Control UI** 或 **Tailscale/SSH** 從筆電/手機連線。
- 將 VPS 視為唯一可信來源，並**備份**狀態與工作區。
- 安全預設：將 Gateway 綁定在 loopback，並透過 SSH 隧道或 Tailscale Serve 存取。
  若綁定於 `lan`/`tailnet`，則需要求 `gateway.auth.token` 或 `gateway.auth.password`。

遠端存取：[Gateway remote](/gateway/remote)  
平台中心：[Platforms](/platforms)

## VPS 上的共用公司代理

當使用者屬於同一信任邊界（例如同一公司團隊），且代理僅用於商務用途時，此設定是有效的。

- 將其放在專用執行環境（VPS/虛擬機/容器 + 專用作業系統使用者/帳號）。
- 不要將該執行環境登入個人 Apple/Google 帳號或個人瀏覽器/密碼管理器。
- 若使用者彼此有對立關係，請依 Gateway/主機/作業系統使用者分開。

安全模型詳情：[Security](/gateway/security)

## 在 VPS 上使用節點

你可以將 Gateway 保持在雲端，並在本地裝置（Mac/iOS/Android/無頭裝置）配對 **節點**。
節點提供本地螢幕/相機/畫布與 `system.run` 功能，而 Gateway 則維持在雲端。

文件：[Nodes](/nodes)、[Nodes CLI](/cli/nodes)

## 小型虛擬機與 ARM 主機的啟動調校

如果在低功耗虛擬機（或 ARM 主機）上執行 CLI 指令感覺很慢，請啟用 Node 的模組編譯快取：

```bash
grep -q 'NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache' ~/.bashrc || cat >> ~/.bashrc <<'EOF'
export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
mkdir -p /var/tmp/openclaw-compile-cache
export OPENCLAW_NO_RESPAWN=1
EOF
source ~/.bashrc
```

- `NODE_COMPILE_CACHE` 改善重複指令的啟動時間。
- `OPENCLAW_NO_RESPAWN=1` 避免因自我重啟路徑帶來的額外啟動負擔。
- 第一次執行指令會預熱快取；後續執行會更快。
- 有關 Raspberry Pi 的詳細資訊，請參考 [Raspberry Pi](/platforms/raspberry-pi)。

### systemd 調校清單（可選）

對於使用 `systemd` 的虛擬機主機，建議：

- 新增服務環境變數以穩定啟動路徑：
  - `OPENCLAW_NO_RESPAWN=1`
  - `NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache`
- 明確設定重啟行為：
  - `Restart=always`
  - `RestartSec=2`
  - `TimeoutStartSec=90`
- 優先使用 SSD 支援的磁碟作為狀態/快取路徑，以降低隨機 I/O 冷啟動的效能損失。

範例：

```bash
sudo systemctl edit openclaw
```

```ini
[Service]
Environment=OPENCLAW_NO_RESPAWN=1
Environment=NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
Restart=always
RestartSec=2
TimeoutStartSec=90
```

`Restart=` 政策如何協助自動恢復：
[systemd 可以自動化服務恢復](https://www.redhat.com/en/blog/systemd-automate-recovery)。
