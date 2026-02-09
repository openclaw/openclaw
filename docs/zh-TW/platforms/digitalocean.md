---
summary: "在 DigitalOcean 上執行 OpenClaw（簡單的付費 VPS 選項）"
read_when:
  - 在 DigitalOcean 上設定 OpenClaw
  - 尋找便宜的 OpenClaw VPS 主機
title: "DigitalOcean"
---

# OpenClaw on DigitalOcean

## 目標

在 DigitalOcean 上執行一個持續運作的 OpenClaw Gateway 閘道器，費用為 **每月 $6 美元**（或使用預留定價每月 $4）。

如果你想要每月 $0 的選項，且不介意 ARM 架構與供應商特定的設定，請參考 [Oracle Cloud 指南](/platforms/oracle)。

## 費用比較（2026）

| 提供者          | 方案              | 規格                 | 每月價格                        | Notes            |
| ------------ | --------------- | ------------------ | --------------------------- | ---------------- |
| Oracle Cloud | Always Free ARM | 最多 4 OCPU、24GB RAM | $0                          | ARM、容量有限／註冊流程較繁瑣 |
| Hetzner      | CX22            | 2 vCPU、4GB RAM     | €3.79（約 $4） | 最便宜的付費選項         |
| DigitalOcean | Basic           | 1 vCPU、1GB RAM     | $6                          | UI 簡單、文件完善       |
| Vultr        | Cloud Compute   | 1 vCPU、1GB RAM     | $6                          | Many locations   |
| Linode       | Nanode          | 1 vCPU、1GB RAM     | $5                          | 現已隸屬於 Akamai     |

**選擇提供者：**

- DigitalOcean：最簡單的使用體驗＋可預期的設定流程（本指南）
- Hetzner：價格／效能表現佳（請見 [Hetzner 指南](/install/hetzner)）
- Oracle Cloud：可達每月 $0，但較為挑剔且僅支援 ARM（請見 [Oracle 指南](/platforms/oracle)）

---

## 先決條件

- DigitalOcean 帳號（[註冊可獲得 $200 免費額度](https://m.do.co/c/signup)）
- SSH 金鑰組（或願意使用密碼驗證）
- 約 20 分鐘

## 1. 建立 Droplet

1. 登入 [DigitalOcean](https://cloud.digitalocean.com/)
2. 點擊 **Create → Droplets**
3. 選擇：
   - **Region：** 距離你（或你的使用者）最近的地區
   - **Image：** Ubuntu 24.04 LTS
   - **Size：** Basic → Regular → **$6/月**（1 vCPU、1GB RAM、25GB SSD）
   - **Authentication：** SSH 金鑰（建議）或密碼
4. 點擊 **Create Droplet**
5. 記下 IP 位址

## 2) 透過 SSH 連線

```bash
ssh root@YOUR_DROPLET_IP
```

## 3. 安裝 OpenClaw

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Install OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# Verify
openclaw --version
```

## 4. 執行入門引導

```bash
openclaw onboard --install-daemon
```

精靈將引導你完成：

- 模型身分驗證（API 金鑰或 OAuth）
- 頻道設定（Telegram、WhatsApp、Discord 等）
- Gateway 閘道器權杖（自動產生）
- 常駐服務安裝（systemd）

## 5. 驗證 Gateway 閘道器

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6. 存取控制台

The gateway binds to loopback by default. 要存取控制介面（Control UI）：

**選項 A：SSH 通道（建議）**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**選項 B：Tailscale Serve（HTTPS，僅限 loopback）**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

開啟：`https://<magicdns>/`

注意事項：

- Serve keeps the Gateway loopback-only and authenticates via Tailscale identity headers.
- 若要改為要求權杖／密碼，請設定 `gateway.auth.allowTailscale: false` 或使用 `gateway.auth.mode: "password"`。

**選項 C：Tailnet 綁定（不使用 Serve）**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

開啟：`http://<tailscale-ip>:18789`（需要權杖）。

## 7. 連接你的頻道

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

其他提供者請參考 [Channels](/channels)。

---

## 針對 1GB RAM 的最佳化

$6 的 Droplet 僅有 1GB RAM。為了讓系統穩定運作： To keep things running smoothly:

### 新增 swap（建議）

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 使用較輕量的模型

如果你遇到 OOM（記憶體不足），可考慮：

- 使用 API 型模型（Claude、GPT）而非本地模型
- 將 `agents.defaults.model.primary` 設為較小的模型

### 監控記憶體

```bash
free -h
htop
```

---

## 持久性

All state lives in:

- `~/.openclaw/` — 設定、憑證、工作階段資料
- `~/.openclaw/workspace/` — 工作區（SOUL.md、記憶等）

These survive reboots. Back them up periodically:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Oracle Cloud 免費替代方案

Oracle Cloud 提供 **Always Free** 的 ARM 執行個體，其效能明顯優於此處任何付費選項，且費用為每月 $0。

| 你可以獲得什麼        | 規格               |
| -------------- | ---------------- |
| **4 OCPU**     | ARM Ampere A1    |
| **24GB RAM**   | More than enough |
| **200GB 儲存空間** | 區塊儲存區            |
| **永久免費**       | 不會收取信用卡費用        |

**注意事項：**

- Signup can be finicky (retry if it fails)
- ARM 架構——大多數功能可用，但部分二進位檔需要 ARM 版本

For the full setup guide, see [Oracle Cloud](/platforms/oracle). 如需註冊技巧與註冊流程疑難排解，請參閱此 [社群指南](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)。

---

## Troubleshooting

### Gateway 閘道器無法啟動

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### 連接埠已被使用

```bash
lsof -i :18789
kill <PID>
```

### 記憶體不足

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## See Also

- [Hetzner 指南](/install/hetzner) — 更便宜、效能更強
- [Docker 安裝](/install/docker) — 容器化設定
- [Tailscale](/gateway/tailscale) — 安全的遠端存取
- [Configuration](/gateway/configuration) — 完整設定參考
