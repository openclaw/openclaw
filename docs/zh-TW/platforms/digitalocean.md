---
summary: "DigitalOcean 上的 OpenClaw (簡單付費的 VPS 選項)"
read_when:
  - 在 DigitalOcean 上設定 OpenClaw 時
  - 尋找 OpenClaw 便宜的 VPS 主機代管時
title: "DigitalOcean"
---

# DigitalOcean 上的 OpenClaw

## 目標

在 DigitalOcean 上執行一個持久的 OpenClaw Gateway，每月只需 **$6** (或預留定價為每月 $4)。

如果您想要每月 $0 的選項，並且不介意 ARM + 供應商特定的設定，請參閱 [Oracle Cloud 指南](/platforms/oracle)。

## 成本比較 (2026)

| 供應商     | 方案            | 規格                  | 每月價格    | 備註                                 |
| ------------ | --------------- | ---------------------- | ----------- | ------------------------------------- |
| Oracle Cloud | 永久免費 ARM | 高達 4 OCPU, 24GB 記憶體 | $0          | ARM, 容量有限 / 註冊問題 |
| Hetzner      | CX22            | 2 虛擬 CPU, 4GB 記憶體        | €3.79 (約 $4) | 最便宜的付費選項                  |
| DigitalOcean | 基本           | 1 虛擬 CPU, 1GB 記憶體        | $6          | 易於使用的介面，優質檔案                    |
| Vultr        | 雲端運算   | 1 虛擬 CPU, 1GB 記憶體        | $6          | 許多地點                        |
| Linode       | Nanode          | 1 虛擬 CPU, 1GB 記憶體        | $5          | 現為 Akamai 的一部分                    |

**選擇供應商：**

- DigitalOcean：最簡單的使用者體驗 + 可預期的設定 (本指南)
- Hetzner：性價比高 (請參閱 [Hetzner 指南](/install/hetzner))
- Oracle Cloud：每月可為 $0，但更為挑剔且僅限 ARM (請參閱 [Oracle 指南](/platforms/oracle))

---

## 先決條件

- DigitalOcean 帳戶 ([註冊可獲得 $200 免費額度](https://m.do.co/c/signup))
- SSH 金鑰對 (或願意使用密碼驗證)
- 約 20 分鐘

## 1) 建立 Droplet

1. 登入 [DigitalOcean](https://cloud.digitalocean.com/)
2. 點擊 **Create → Droplets**
3. 選擇：
   - **區域：** 離您 (或您的使用者) 最近的
   - **映像檔：** Ubuntu 24.04 LTS
   - **大小：** 基本 → 常規 → **每月 $6** (1 虛擬 CPU, 1GB 記憶體, 25GB SSD)
   - **驗證：** SSH 金鑰 (建議) 或密碼
4. 點擊 **Create Droplet**
5. 記下 IP 位址

## 2) 透過 SSH 連線

```bash
ssh root @YOUR_DROPLET_IP
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

## 4) 執行上線設定

```bash
openclaw onboard --install-daemon
```

精靈將引導您完成：

- 模型驗證 (API 金鑰或 OAuth)
- 通道設定 (Telegram, WhatsApp, Discord 等)
- Gateway 權杖 (自動生成)
- 守護程式安裝 (systemd)

## 5) 驗證 Gateway

```bash
# 檢查狀態
openclaw status

# 檢查服務
systemctl --user status openclaw-gateway.service

# 查看日誌
journalctl --user -u openclaw-gateway.service -f
```

## 6) 存取儀表板

Gateway 預設綁定到迴環介面。若要存取控制 UI：

**選項 A: SSH 隧道 (建議)**

```bash
# 從您的本地機器
ssh -L 18789:localhost:18789 root @YOUR_DROPLET_IP

# 然後開啟：http://localhost:18789
```

**選項 B: Tailscale Serve (HTTPS, 僅限迴環)**

```bash
# 在 Droplet 上
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# 設定 Gateway 以使用 Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

開啟：`https://<magicdns>/`

備註：

- Serve 保持 Gateway 僅限迴環，並透過 Tailscale 身份標頭進行驗證。
- 若要改為要求權杖/密碼，請設定 `gateway.auth.allowTailscale: false` 或使用 `gateway.auth.mode: "password"`。

**選項 C: Tailnet 綁定 (不安裝 Serve)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

開啟：`http://<tailscale-ip>:18789` (需要權杖)。

## 7) 連接您的通道

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# 掃描 QR 碼
```

請參閱 [通道](/channels) 以了解其他供應商。

---

## 針對 1GB 記憶體的優化

每月 $6 的 Droplet 只有 1GB 記憶體。為了讓其順暢運行：

### 增加交換空間 (建議)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 使用較輕量的模型

如果您遇到記憶體不足 (OOM) 的情況，請考慮：

- 使用基於 API 的模型 (Claude, GPT) 而非本地模型
- 將 `agents.defaults.model.primary` 設定為較小的模型

### 監控記憶體

```bash
free -h
htop
```

---

## 持久性

所有狀態都儲存在：

- `~/.openclaw/` — 設定、憑證、會話資料
- `~/.openclaw/workspace/` — 工作區 (SOUL.md、記憶體等)

這些在重啟後仍然存在。請定期備份：

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Oracle Cloud 免費替代方案

Oracle Cloud 提供 **永久免費** 的 ARM 實例，它們比此處的任何付費選項都強大得多 — 每月 $0。

| 您將獲得      | 規格                  |
| ----------------- | ---------------------- |
| **4 OCPU**       | ARM Ampere A1          |
| **24GB 記憶體**      | 綽綽有餘       |
| **200GB 儲存空間** | 區塊儲存           |
| **永久免費**  | 無信用卡費用 |

**注意事項：**

- 註冊可能很挑剔 (如果失敗請重試)
- ARM 架構 — 大多數東西都能運行，但有些二進位檔案需要 ARM 建構

有關完整的設定指南，請參閱 [Oracle Cloud](/platforms/oracle)。有關註冊技巧和註冊過程的疑難排解，請參閱此 [社群指南](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)。

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

# 增加更多交換空間
# 或升級到每月 $12 的 Droplet (2GB 記憶體)
```

---

## 另請參閱

- [Hetzner 指南](/install/hetzner) — 更便宜、更強大
- [Docker 安裝](/install/docker) — 容器化設定
- [Tailscale](/gateway/tailscale) — 安全遠端存取
- [設定](/gateway/configuration) — 完整設定參考
