---
summary: "Raspberry Pi 上的 OpenClaw（低成本自架設方案）"
read_when:
  - 在 Raspberry Pi 上設定 OpenClaw
  - 在 ARM 裝置上執行 OpenClaw
  - 打造便宜且全天候運作的個人 AI
title: "Raspberry Pi"
---

# Raspberry Pi 上的 OpenClaw

## 目標

在 Raspberry Pi 上執行一個持久、全天候運作的 OpenClaw Gateway 閘道器，一次性成本約 **~$35-80**（無每月費用）。

適合用於：

- 24/7 個人 AI 助手
- 家庭自動化中樞
- 低功耗、隨時可用的 Telegram / WhatsApp 機器人

## 硬體需求

| Pi 型號           | RAM     | 可用？      | 注意事項               |
| --------------- | ------- | -------- | ------------------ |
| **Pi 5**        | 4GB/8GB | ✅ 最佳     | 最快，建議使用            |
| **Pi 4**        | 4GB     | ✅ 良好     | 多數使用者的甜蜜點          |
| **Pi 4**        | 2GB     | ✅ 尚可     | 可用，請增加 swap        |
| **Pi 4**        | 1GB     | ⚠️ Tight | 透過 swap 可行，最小化設定   |
| **Pi 3B+**      | 1GB     | ⚠️ 慢     | Works but sluggish |
| **Pi Zero 2 W** | 512MB   | ❌        | 不建議                |

**最低規格：** 1GB RAM、1 核心、500MB 磁碟  
**建議：** 2GB+ RAM、64 位元 OS、16GB+ SD 卡（或 USB SSD）

## What You'll Need

- Raspberry Pi 4 或 5（建議 2GB+）
- MicroSD 卡（16GB+）或 USB SSD（效能更佳）
- 電源供應器（建議使用官方 Pi PSU）
- 網路連線（乙太網路或 WiFi）
- 約 30 分鐘

## 1. 燒錄作業系統

使用 **Raspberry Pi OS Lite（64-bit）** —— 無需桌面環境，適合無頭伺服器。

1. 下載 [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. 選擇 OS：**Raspberry Pi OS Lite（64-bit）**
3. Click the gear icon (⚙️) to pre-configure:
   - 設定主機名稱：`gateway-host`
   - 啟用 SSH
   - 設定使用者名稱／密碼
   - 設定 WiFi（若未使用乙太網路）
4. 燒錄到 SD 卡／USB 磁碟
5. 插入並啟動 Pi

## 2) 透過 SSH 連線

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3. 系統設定

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y git curl build-essential

# Set timezone (important for cron/reminders)
sudo timedatectl set-timezone America/Chicago  # Change to your timezone
```

## 4. 安裝 Node.js 22（ARM64）

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v22.x.x
npm --version
```

## 5. 新增 Swap（2GB 或以下很重要）

Swap 可避免記憶體不足（out-of-memory）當機：

```bash
# Create 2GB swap file
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Optimize for low RAM (reduce swappiness)
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 6. 安裝 OpenClaw

### 選項 A：標準安裝（建議）

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### 選項 B：可改造安裝（適合動手調整）

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

The hackable install gives you direct access to logs and code — useful for debugging ARM-specific issues.

## 7. 執行入門引導

```bash
openclaw onboard --install-daemon
```

Follow the wizard:

1. **Gateway 模式：** Local
2. **Auth：** 建議使用 API 金鑰（OAuth 在無頭 Pi 上可能較不穩定）
3. **Channels：** Telegram 最容易開始
4. **Daemon：** 是（systemd）

## 8) 驗證安裝

```bash
# Check status
openclaw status

# Check service
sudo systemctl status openclaw

# View logs
journalctl -u openclaw -f
```

## 9. 存取儀表板

由於 Pi 是無頭的，請使用 SSH 通道：

```bash
# From your laptop/desktop
ssh -L 18789:localhost:18789 user@gateway-host

# Then open in browser
open http://localhost:18789
```

或使用 Tailscale 進行全天候存取：

```bash
# On the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Update config
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## 效能最佳化

### 使用 USB SSD（大幅提升）

SD cards are slow and wear out. SD 卡速度慢且容易耗損。USB SSD 可顯著提升效能：

```bash
# Check if booting from USB
lsblk
```

設定方式請參考 [Pi USB 開機指南](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot)。

### 降低記憶體使用量

```bash
# Disable GPU memory allocation (headless)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Disable Bluetooth if not needed
sudo systemctl disable bluetooth
```

### 監控資源

```bash
# Check memory
free -h

# Check CPU temperature
vcgencmd measure_temp

# Live monitoring
htop
```

---

## ARM 特定注意事項

### 二進位相容性

大多數 OpenClaw 功能可在 ARM64 上運作，但部分外部二進位檔需要 ARM 版本：

| 工具                      | ARM64 狀態 | 注意事項                                |
| ----------------------- | -------- | ----------------------------------- |
| Node.js | ✅        | 運作良好                                |
| WhatsApp（Baileys）       | ✅        | 純 JS，無問題                            |
| Telegram                | ✅        | 純 JS，無問題                            |
| gog（Gmail CLI）          | ⚠️       | 請確認是否有 ARM 發行版                      |
| Chromium（瀏覽器）           | ✅        | `sudo apt install chromium-browser` |

If a skill fails, check if its binary has an ARM build. Many Go/Rust tools do; some don't.

### 32 位元 vs 64 位元

**一律使用 64 位元 OS。** Node.js 與許多現代工具都需要。可用以下方式確認： Check with:

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## 建議的模型設定

由於 Pi 僅作為 Gateway 閘道器（模型在雲端執行），請使用 API 型模型：

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-20250514",
        "fallbacks": ["openai/gpt-4o-mini"]
      }
    }
  }
}
```

**不要嘗試在 Pi 上執行本地 LLM** —— 即使是小模型也太慢。把重活交給 Claude / GPT。 Let Claude/GPT do the heavy lifting.

---

## 開機自動啟動

入門精靈會設定此項，但你可以確認：

```bash
# Check service is enabled
sudo systemctl is-enabled openclaw

# Enable if not
sudo systemctl enable openclaw

# Start on boot
sudo systemctl start openclaw
```

---

## Troubleshooting

### 記憶體不足（OOM）

```bash
# Check memory
free -h

# Add more swap (see Step 5)
# Or reduce services running on the Pi
```

### 效能緩慢

- 使用 USB SSD 取代 SD 卡
- 停用未使用的服務：`sudo systemctl disable cups bluetooth avahi-daemon`
- 檢查 CPU 節流：`vcgencmd get_throttled`（應回傳 `0x0`）

### 服務無法啟動

```bash
# Check logs
journalctl -u openclaw --no-pager -n 100

# Common fix: rebuild
cd ~/openclaw  # if using hackable install
npm run build
sudo systemctl restart openclaw
```

### ARM 二進位問題

若某個 skill 以「exec format error」失敗：

1. 確認是否有 ARM64 版本
2. Try building from source
3. 或使用支援 ARM 的 Docker 容器

### WiFi 掉線

針對使用 WiFi 的無頭 Pi：

```bash
# Disable WiFi power management
sudo iwconfig wlan0 power off

# Make permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## 成本比較

| 設定            | 一次性成本                | 每月成本                    | 注意事項                        |
| ------------- | -------------------- | ----------------------- | --------------------------- |
| **Pi 4（2GB）** | ~$45 | $0                      | + 電力（~$5/年） |
| **Pi 4（4GB）** | ~$55 | $0                      | 建議                          |
| **Pi 5（4GB）** | ~$60 | $0                      | 最佳效能                        |
| **Pi 5（8GB）** | ~$80 | $0                      | Overkill but future-proof   |
| DigitalOcean  | $0                   | $6/月                    | $72/年                       |
| Hetzner       | $0                   | €3.79/月 | ~$50/年      |

**回本點：** 相較雲端 VPS，Pi 約 **6-12 個月**即可回本。

---

## See Also

- [Linux 指南](/platforms/linux) — 一般 Linux 設定
- [DigitalOcean 指南](/platforms/digitalocean) — 雲端替代方案
- [Hetzner 指南](/install/hetzner) — Docker 設定
- [Tailscale](/gateway/tailscale) — 遠端存取
- [Nodes](/nodes) — 將你的筆電／手機與 Pi Gateway 閘道器配對
