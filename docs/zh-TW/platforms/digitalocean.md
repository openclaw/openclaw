---
summary: "在 DigitalOcean 上執行 OpenClaw (簡易付費 VPS 選項)"
read_when:
  - 在 DigitalOcean 上設定 OpenClaw
  - 尋找適用於 OpenClaw 的廉價 VPS 託管
title: "DigitalOcean"
---

# 在 DigitalOcean 上執行 OpenClaw

## 目標

在 DigitalOcean 上執行持續運作的 OpenClaw Gateway，每月只需 **$6**（或使用預留價格每月 $4）。

如果您想要每月 $0 的選項，且不介意使用 ARM 及特定供應商的設定，請參閱 [Oracle Cloud 指南](/platforms/oracle)。

## 費用比較 (2026)

| 供應商       | 方案            | 規格                  | 每月價格    | 備註                           |
| ------------ | --------------- | --------------------- | ----------- | ------------------------------ |
| Oracle Cloud | Always Free ARM | 高達 4 OCPU, 24GB RAM | $0          | ARM，容量有限 / 註冊流程較特殊 |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM       | €3.79 (~$4) | 最便宜的付費選項               |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM       | $6          | 介面簡單，文件豐富             |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM       | $6          | 節點位置眾多                   |
| Linode       | Nanode          | 1 vCPU, 1GB RAM       | $5          | 現為 Akamai 的一部分           |

**選擇供應商：**

- DigitalOcean：最簡單的使用者體驗 + 可預測的設定（本指南）
- Hetzner：良好的性價比（參閱 [Hetzner 指南](/install/hetzner)）
- Oracle Cloud：可以低至每月 $0，但較為繁瑣且僅限 ARM（參閱 [Oracle 指南](/platforms/oracle)）

---

## 前置作業

- DigitalOcean 帳號（[註冊即可獲得 $200 免費額度](https://m.do.co/c/signup)）
- SSH 金鑰對（或願意使用密碼驗證）
- 約 20 分鐘

## 1) 建立 Droplet

1. 登入 [DigitalOcean](https://cloud.digitalocean.com/)
2. 點擊 **Create → Droplets**
3. 選擇：
   - **Region：** 離您（或您的使用者）最近的地方
   - **Image：** Ubuntu 24.04 LTS
   - **Size：** Basic → Regular → **$6/mo** (1 vCPU, 1GB RAM, 25GB SSD)
   - **Authentication：** SSH 金鑰（推薦）或密碼
4. 點擊 **Create Droplet**
5. 記下 IP 位址

## 2) 透過 SSH 連線

```bash
ssh root@YOUR_DROPLET_IP
```

## 3) 安裝 OpenClaw

```bash
# 更新系統
apt update && apt upgrade -y

# 安裝 Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# 安裝 OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# 驗證
openclaw --version
```

## 4) 執行新手導覽

```bash
openclaw onboard --install-daemon
```

精靈將引導您完成：

- 模型驗證（API 金鑰或 OAuth）
- 頻道設定（Telegram、WhatsApp、Discord 等）
- Gateway 權杖（自動產生）
- 守護程序安裝（systemd）

## 5) 驗證 Gateway

```bash
# 檢查狀態
openclaw status

# 檢查服務
systemctl --user status openclaw-gateway.service

# 查看日誌
journalctl --user -u openclaw-gateway.service -f
```

## 6) 存取控制面板

Gateway 預設綁定到 local loopback。要存取控制 UI：

**選項 A：SSH 通道（推薦）**

```bash
# 從您的本機電腦執行
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# 然後開啟：http://localhost:18789
```

**選項 B：Tailscale Serve（HTTPS，僅限 loopback）**

```bash
# 在 Droplet 上執行
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# 設定 Gateway 使用 Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

開啟：`https://<magicdns>/`

備註：

- Serve 讓 Gateway 維持僅限 loopback 並透過 Tailscale 身分識別標頭進行驗證。
- 若要改為要求權杖/密碼，請設定 `gateway.auth.allowTailscale: false` 或使用 `gateway.auth.mode: "password"`。

**選項 C：Tailnet 綁定（無 Serve）**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

開啟：`http://<tailscale-ip>:18789`（需要權杖）。

## 7) 連接您的頻道

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# 掃描 QR code
```

請參閱 [頻道](/channels) 以了解其他供應商。

---

## 針對 1GB 記憶體的優化

$6 的 Droplet 只有 1GB 記憶體。為了保持運作順暢：

### 新增 Swap（推薦）

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 使用較輕量的模型

如果您遇到記憶體不足（OOM），請考慮：

- 使用基於 API 的模型（Claude、GPT）而非本地模型
- 將 `agents.defaults.model.primary` 設定為較小的模型

### 監控記憶體

```bash
free -h
htop
```

---

## 持久化

所有狀態儲存在：

- `~/.openclaw/` — 設定、憑證、工作階段資料
- `~/.openclaw/workspace/` — 工作區（SOUL.md、記憶體等）

這些資料在重新開機後仍會保留。請定期備份：

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Oracle Cloud 免費替代方案

Oracle Cloud 提供 **Always Free** ARM 執行個體，效能比這裡列出的任何付費選項都強大得多 — 每月只需 $0。

| 您將獲得           | 規格               |
| ------------------ | ------------------ |
| **4 OCPUs**        | ARM Ampere A1      |
| **24GB 記憶體**    | 綽綽有餘           |
| **200GB 儲存空間** | 區塊磁碟區         |
| **永久免費**       | 不會產生信用卡費用 |

**注意事項：**

- 註冊過程可能較繁瑣（如果失敗請重試）
- ARM 架構 — 大部分功能可正常運作，但某些二進位檔案需要 ARM 版本

如需完整設定指南，請參閱 [Oracle Cloud](/platforms/oracle)。有關註冊提示和註冊流程的疑難排解，請參閱此 [社群指南](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)。

---

## 疑難排解

### Gateway 無法啟動

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### 連接埠已被佔用

```bash
lsof -i :18789
kill <PID>
```

### 記憶體不足

```bash
# 檢查記憶體
free -h

# 新增更多 Swap
# 或升級至每月 $12 的 Droplet（2GB 記憶體）
```

---

## 延伸閱讀

- [Hetzner 指南](/install/hetzner) — 更便宜、更強大
- [Docker 安裝](/install/docker) — 容器化設定
- [Tailscale](/gateway/tailscale) — 安全遠端存取
- [設定](/gateway/configuration) — 完整設定參考
