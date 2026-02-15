---
summary: "在 Raspberry Pi 上執行 OpenClaw（經濟型自託管設定）"
read_when:
  - 在 Raspberry Pi 上設定 OpenClaw
  - 在 ARM 裝置上執行 OpenClaw
  - 建構經濟實惠的常駐個人 AI
title: "Raspberry Pi"
---

# 在 Raspberry Pi 上執行 OpenClaw

## 目標

在 Raspberry Pi 上執行一個持續、常駐的 OpenClaw Gateway，一次性成本約為 **$35-80**（無月費）。

最適合：

- 24/7 個人 AI 助理
- 家庭自動化中心
- 低功耗、隨時可用的 Telegram/WhatsApp 機器人

## 硬體需求

| Pi Model        | RAM     | 可行嗎？ | 備註                               |
| --------------- | ------- | -------- | ---------------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ 最佳  | 最快，建議使用                     |
| **Pi 4**        | 4GB     | ✅ 良好  | 大多數使用者的最佳選擇             |
| **Pi 4**        | 2GB     | ✅ 尚可  | 可行，增加交換空間                 |
| **Pi 4**        | 1GB     | ⚠️ 緊繃  | 增加交換空間並進行最少設定後可行   |
| **Pi 3B+**      | 1GB     | ⚠️ 緩慢  | 可行但緩慢                         |
| **Pi Zero 2 W** | 512MB   | ❌       | 不建議使用                         |

**最低規格：** 1GB 記憶體, 1 核心, 500MB 磁碟空間
**建議：** 2GB+ 記憶體, 64 位元作業系統, 16GB+ SD 卡 (或 USB SSD)

## 您將需要

- Raspberry Pi 4 或 5 (建議 2GB+)
- MicroSD 卡 (16GB+) 或 USB SSD (效能更佳)
- 電源供應器 (建議使用官方 Pi 電源供應器)
- 網路連線 (乙太網路或 WiFi)
- 約 30 分鐘

## 1) 燒錄作業系統

使用 **Raspberry Pi OS Lite (64 位元)** — 無需桌面即可用於無頭伺服器。

1. 下載 [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. 選擇作業系統：**Raspberry Pi OS Lite (64 位元)**
3. 點擊齒輪圖示 (⚙️) 進行預先設定：
   - 設定主機名稱：`gateway-host`
   - 啟用 SSH
   - 設定使用者名稱/密碼
   - 設定 WiFi (如果不安裝乙太網路)
4. 燒錄到您的 SD 卡 / USB 隨身碟
5. 插入並啟動 Pi

## 2) 透過 SSH 連線

```bash
ssh user @gateway-host
# 或使用 IP 位址
ssh user @192.168.x.x
```

## 3) 系統設定

```bash
# 更新系統
sudo apt update && sudo apt upgrade -y

# 安裝必要套件
sudo apt install -y git curl build-essential

# 設定時區 (對於排程/提醒很重要)
sudo timedatectl set-timezone America/Chicago  # 更改為您的時區
```

## 4) 安裝 Node.js 22 (ARM64)

```bash
# 透過 NodeSource 安裝 Node.js
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 驗證
node --version  # 應顯示 v22.x.x
npm --version
```

## 5) 增加交換空間 (對於 2GB 或更少記憶體很重要)

交換空間可防止記憶體不足導致的當機：

```bash
# 建立 2GB 交換檔
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# 永久生效
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 優化低記憶體 (降低 swappiness)
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 6) 安裝 OpenClaw

### 選項 A：標準安裝 (建議)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### 選項 B：可修改的安裝 (適用於修改)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

可修改的安裝讓您可以直接存取日誌和程式碼 — 這對於偵錯 ARM 特定問題很有用。

## 7) 執行新手導覽

```bash
openclaw onboard --install-daemon
```

依照精靈指示：

1. **Gateway 模式：** Local
2. **憑證：** 建議使用 API 金鑰 (OAuth 在無頭 Pi 上可能不穩定)
3. **頻道：** Telegram 最容易上手
4. **守護行程：** Yes (systemd)

## 8) 驗證安裝

```bash
# 檢查狀態
openclaw status

# 檢查服務
sudo systemctl status openclaw

# 查看日誌
journalctl -u openclaw -f
```

## 9) 存取儀表板

由於 Pi 是無頭設備，請使用 SSH 通道：

```bash
# 從您的筆記型電腦/桌上型電腦
ssh -L 18789:localhost:18789 user @gateway-host

# 然後在瀏覽器中開啟
open http://localhost:18789
```

或者使用 Tailscale 進行常駐存取：

```bash
# 在 Pi 上
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# 更新設定
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## 效能優化

### 使用 USB SSD (大幅改進)

SD 卡速度慢且容易損壞。USB SSD 可顯著提升效能：

```bash
# 檢查是否從 USB 啟動
lsblk
```

有關設定，請參閱 [Pi USB 啟動指南](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot)。

### 減少記憶體用量

```bash
# 停用 GPU 記憶體分配 (無頭設備)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# 如果不需要，請停用藍牙
sudo systemctl disable bluetooth
```

### 監控資源

```bash
# 檢查記憶體
free -h

# 檢查 CPU 溫度
vcgencmd measure_temp

# 即時監控
htop
```

---

## ARM 特定注意事項

### 二進位相容性

大多數 OpenClaw 功能可在 ARM64 上運作，但某些外部二進位檔案可能需要 ARM 版本：

| 工具               | ARM64 狀態 | 備註                               |
| ------------------ | ------------ | ---------------------------------- |
| Node.js            | ✅           | 運作良好                           |
| WhatsApp (Baileys) | ✅           | 純 JS，無問題                      |
| Telegram           | ✅           | 純 JS，無問題                      |
| gog (Gmail CLI)    | ⚠️           | 檢查是否有 ARM 版本                |
| Chromium (browser) | ✅           | `sudo apt install chromium-browser` |

如果技能失敗，請檢查其二進位檔案是否有 ARM 版本。許多 Go/Rust 工具都有；有些則沒有。

### 32 位元 vs 64 位元

**始終使用 64 位元作業系統。** Node.js 和許多現代工具都需要它。請透過以下方式檢查：

```bash
uname -m
# 應顯示：aarch64 (64 位元) 而非 armv7l (32 位元)
```

---

## 建議的模型設定

由於 Pi 僅作為 Gateway（模型在雲端執行），請使用基於 API 的模型：

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

**不要嘗試在 Pi 上執行本地 LLM** — 即使是小型模型也太慢了。讓 Claude/GPT 處理繁重的工作。

---

## 開機自動啟動

新手導覽精靈會設定此功能，但您可以驗證：

```bash
# 檢查服務是否啟用
sudo systemctl is-enabled openclaw

# 如果未啟用，則啟用
sudo systemctl enable openclaw

# 開機時啟動
sudo systemctl start openclaw
```

---

## 疑難排解

### 記憶體不足 (OOM)

```bash
# 檢查記憶體
free -h

# 增加更多交換空間 (請參閱步驟 5)
# 或減少在 Pi 上執行的服務
```

### 效能緩慢

- 使用 USB SSD 而非 SD 卡
- 停用未使用的服務：`sudo systemctl disable cups bluetooth avahi-daemon`
- 檢查 CPU 節流：`vcgencmd get_throttled` (應回傳 `0x0`)

### 服務無法啟動

```bash
# 檢查日誌
journalctl -u openclaw --no-pager -n 100

# 常見修復：重建
cd ~/openclaw  # 如果使用可修改的安裝
npm run build
sudo systemctl restart openclaw
```

### ARM 二進位問題

如果技能失敗並出現 "exec format error"：

1. 檢查二進位檔案是否有 ARM64 版本
2. 嘗試從原始碼建置
3. 或使用支援 ARM 的 Docker 容器

### WiFi 斷線

對於使用 WiFi 的無頭 Pi：

```bash
# 停用 WiFi 電源管理
sudo iwconfig wlan0 power off

# 永久生效
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## 成本比較

| 設定          | 一次性成本 | 每月成本 | 備註                               |
| -------------- | ---------- | -------- | ---------------------------------- |
| **Pi 4 (2GB)** | ~$45       | $0       | + 電源 (~$5/年)                    |
| **Pi 4 (4GB)** | ~$55       | $0       | 建議使用                           |
| **Pi 5 (4GB)** | ~$60       | $0       | 最佳效能                           |
| **Pi 5 (8GB)** | ~$80       | $0       | 性能過剩但具備未來性               |
| DigitalOcean   | $0         | $6/月    | $72/年                             |
| Hetzner        | $0         | €3.79/月 | ~$50/年                            |

**損益平衡點：** 與雲端虛擬私人伺服器 (VPS) 相比，Pi 大約在 6-12 個月內即可回本。

---

## 參閱

- [Linux 指南](/platforms/linux) — 一般 Linux 設定
- [DigitalOcean 指南](/platforms/digitalocean) — 雲端替代方案
- [Hetzner 指南](/install/hetzner) — Docker 設定
- [Tailscale](/gateway/tailscale) — 遠端存取
- [節點](/nodes) — 將您的筆記型電腦/手機與 Pi Gateway 配對
