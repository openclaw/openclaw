---
summary: OpenClaw on DigitalOcean (simple paid VPS option)
read_when:
  - Setting up OpenClaw on DigitalOcean
  - Looking for cheap VPS hosting for OpenClaw
title: DigitalOcean
---

# DigitalOcean 上的 OpenClaw

## 目標

在 DigitalOcean 上以 **每月 6 美元**（或預付方案每月 4 美元）執行持續性的 OpenClaw Gateway。

如果你想要每月 0 元的方案，且不介意 ARM 架構及供應商特定的設定，請參考 [Oracle Cloud 指南](/platforms/oracle)。

## 成本比較（2026）

| 供應商       | 方案            | 規格                  | 價格/月     | 備註                               |
| ------------ | --------------- | --------------------- | ----------- | ---------------------------------- |
| Oracle Cloud | Always Free ARM | 最多 4 OCPU，24GB RAM | $0          | ARM 架構，容量有限／註冊有特殊規定 |
| Hetzner      | CX22            | 2 vCPU，4GB RAM       | €3.79 (~$4) | 最便宜的付費方案                   |
| DigitalOcean | Basic           | 1 vCPU，1GB RAM       | $6          | 介面簡單，文件完善                 |
| Vultr        | Cloud Compute   | 1 vCPU，1GB RAM       | $6          | 多個地點選擇                       |
| Linode       | Nanode          | 1 vCPU，1GB RAM       | $5          | 現為 Akamai 旗下                   |

**選擇供應商：**

- DigitalOcean：最簡單的使用者體驗與可預期的設定（本指南）
- Hetzner：價格效能比佳（參見 [Hetzner 指南](/install/hetzner)）
- Oracle Cloud：可免費使用，但較為複雜且僅支援 ARM（參見 [Oracle 指南](/platforms/oracle)）

---

## 前置條件

- DigitalOcean 帳號（[註冊可獲得 200 美元免費額度](https://m.do.co/c/signup)）
- SSH 金鑰對（或願意使用密碼認證）
- 約 20 分鐘時間

## 1) 建立 Droplet

<Warning>
請使用乾淨的基礎映像（Ubuntu 24.04 LTS）。除非你已檢查過啟動腳本與防火牆預設，否則避免使用第三方 Marketplace 一鍵映像。
</Warning>

1. 登入 [DigitalOcean](https://cloud.digitalocean.com/)
2. 點選 **Create → Droplets**
3. 選擇：
   - **Region（地區）：** 選擇離你（或你的使用者）最近的地區
   - **Image（映像）：** Ubuntu 24.04 LTS
   - **Size（規格）：** Basic → Regular → **每月 6 美元**（1 vCPU，1GB RAM，25GB SSD）
   - **Authentication（認證）：** SSH 金鑰（推薦）或密碼
4. 點選 **Create Droplet**
5. 記下 IP 位址

## 2) 透過 SSH 連線

```bash
ssh root@YOUR_DROPLET_IP
```

## 3) 安裝 OpenClaw

bash

# 更新系統

apt update && apt upgrade -y

# 安裝 Node.js 24

curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs

# 安裝 OpenClaw

curl -fsSL https://openclaw.ai/install.sh | bash

# 驗證安裝

openclaw --version

## 4) 執行新手引導

```bash
openclaw onboard --install-daemon
```

新手引導將帶您完成：

- 模型授權（API 金鑰或 OAuth）
- 頻道設定（Telegram、WhatsApp、Discord 等）
- Gateway token（自動產生）
- 守護程序安裝（systemd）

## 5) 驗證 Gateway

bash

# 檢查狀態

openclaw status

# 檢查服務

systemctl --user status openclaw-gateway.service

# 查看日誌

journalctl --user -u openclaw-gateway.service -f

## 6) 存取儀表板

閘道預設綁定在迴圈介面。要存取控制介面：

**選項 A：SSH 隧道（推薦）**

bash

# 從您的本機

ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# 然後開啟：http://localhost:18789

**選項 B：Tailscale Serve（HTTPS，僅限迴圈介面）**

bash

# 在 droplet 上

curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# 設定閘道使用 Tailscale Serve

openclaw config set gateway.tailscale.mode serve
openclaw gateway restart

開啟：`https://<magicdns>/`

注意事項：

- Serve 會讓閘道保持在迴圈介面，並透過 Tailscale 身分標頭驗證控制介面/WebSocket 流量（無 token 認證假設閘道主機受信任；HTTP API 仍需 token/密碼）。
- 若要改為要求 token/密碼，請設定 `gateway.auth.allowTailscale: false` 或使用 `gateway.auth.mode: "password"`。

**選項 C：Tailnet 綁定（不使用 Serve）**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

開啟：`http://<tailscale-ip>:18789`（需要 token）。

## 7) 連接您的頻道

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# Scan QR code
```

請參考 [Channels](/channels) 了解其他服務提供者。

---

## 1GB 記憶體優化建議

$6 的 droplet 只有 1GB 記憶體。為了保持系統順暢運作：

### 新增交換空間（建議）

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 使用較輕量的模型

如果遇到記憶體不足（OOM）問題，建議：

- 使用基於 API 的模型（Claude、GPT）取代本地模型
- 將 `agents.defaults.model.primary` 設定為較小的模型

### 監控記憶體使用狀況

```bash
free -h
htop
```

---

## 持久化

所有狀態資料存放於：

- `~/.openclaw/` — 設定、憑證、會話資料
- `~/.openclaw/workspace/` — 工作區（SOUL.md、記憶體等）

這些資料會在重啟後保留。請定期備份：

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Oracle Cloud 免費替代方案

Oracle Cloud 提供 **Always Free** ARM 實例，效能遠超此處任何付費方案 — 每月 $0。

| 你將獲得           | 規格          |
| ------------------ | ------------- |
| **4 個 OCPU**      | ARM Ampere A1 |
| **24GB 記憶體**    | 足夠使用      |
| **200GB 儲存空間** | 區塊存儲      |
| **永久免費**       | 無信用卡扣款  |

**注意事項：**

- 註冊過程可能不穩定（失敗請重試）
- ARM 架構 — 大部分軟體可用，但部分二進位檔需 ARM 版本

完整安裝指南請參考 [Oracle Cloud](/platforms/oracle)。註冊技巧與問題排解請參考此 [社群指南](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)。

---

## 疑難排解

### Gateway 無法啟動

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### 埠已被使用

```bash
lsof -i :18789
kill <PID>
```

### 記憶體不足

bash

# 檢查記憶體

free -h

# 新增更多 swap 空間

# 或升級到 $12/月 的 droplet（2GB RAM）

---

## 參考資料

- [Hetzner 指南](/install/hetzner) — 更便宜、更強大
- [Docker 安裝](/install/docker) — 容器化設定
- [Tailscale](/gateway/tailscale) — 安全的遠端存取
- [設定](/gateway/configuration) — 完整設定參考
