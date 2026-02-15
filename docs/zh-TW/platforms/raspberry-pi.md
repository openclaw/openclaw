---
summary: "Raspberry Pi 上的 OpenClaw（平價自託管方案）"
read_when:
  - 在 Raspberry Pi 上設定 OpenClaw
  - 在 ARM 裝置上執行 OpenClaw
  - 打造便宜且全天候運作的個人 AI
title: "Raspberry Pi"
---

# OpenClaw 在 Raspberry Pi 上

## 目標

在 Raspberry Pi 上執行持久、全天候運作的 OpenClaw Gateway，一次性成本約 **$35-80** 美元（無月費）。

非常適合：

- 24/7 個人 AI 助理
- 家庭自動化中心
- 低功耗、隨時可用的 Telegram/WhatsApp 機器人

## 硬體需求

| Pi 型號         | RAM     | 可用？  | 備註                           |
| --------------- | ------- | ------- | ------------------------------ |
| **Pi 5**        | 4GB/8GB | ✅ 最佳 | 速度最快，推薦使用             |
| **Pi 4**        | 4GB     | ✅ 良好 | 多數使用者的最佳平衡點         |
| **Pi 4**        | 2GB     | ✅ 尚可 | 可以運作，需新增 Swap          |
| **Pi 4**        | 1GB     | ⚠️ 吃緊 | 可透過 Swap 運作，需最小化設定 |
| **Pi 3B+**      | 1GB     | ⚠️ 緩慢 | 可以運作但反應遲鈍             |
| **Pi Zero 2 W** | 512MB   | ❌      | 不推薦使用                     |

**最低規格：** 1GB RAM, 1 核心, 500MB 磁碟空間  
**建議規格：** 2GB+ RAM, 64 位元作業系統, 16GB+ SD 卡（或 USB SSD）

## 準備工作

- Raspberry Pi 4 或 5（建議 2GB+）
- MicroSD 卡（16GB+）或 USB SSD（效能較佳）
- 電源供應器（建議使用官方 Pi 電源）
- 網路連線（乙太網路或 WiFi）
- 約 30 分鐘時間

## 1) 燒錄作業系統

使用 **Raspberry Pi OS Lite (64-bit)** — Headless 伺服器不需要桌面環境。

1. 下載 [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. 選擇作業系統：**Raspberry Pi OS Lite (64-bit)**
3. 點擊齒輪圖示 (⚙️) 進行預先設定：
   - 設定主機名稱：`gateway-host`
   - 啟用 SSH
   - 設定使用者名稱/密碼
   - 設定 WiFi（若不使用乙太網路）
4. 燒錄至您的 SD 卡 / USB 磁碟
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

# 設定時區（對 cron/提醒功能很重要）
sudo timedatectl set-timezone Asia/Taipei  # 更改為您的時區
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

## 5) 新增 Swap（對於 2GB 或更少記憶體非常重要）

Swap 可防止因記憶體不足 (OOM) 導致的當機：

```bash
# 建立 2GB Swap 檔案
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# 使其永久生效
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 針對低 RAM 進行最佳化（降低 swappiness）
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 6) 安裝 OpenClaw

### 選項 A：標準安裝（建議）

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### 選項 B：開發者安裝（適合自行修改）

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

開發者安裝讓您能直接存取日誌與程式碼 — 對於排查 ARM 特定問題非常有用。

## 7) 執行新手導覽

```bash
openclaw onboard --install-daemon
```

依照精靈指示：

1. **Gateway 模式：** Local
2. **憑證：** 建議使用 API keys（OAuth 在 Headless Pi 上可能較難設定）
3. **頻道：** Telegram 是最容易開始的選擇
4. **守護行程 (Daemon)：** 是 (systemd)

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

由於 Pi 是 Headless 運作，請使用 SSH 通道：

```bash
# 從您的筆電/桌機執行
ssh -L 18789:localhost:18789 user @gateway-host

# 然後在瀏覽器開啟
open http://localhost:18789
```

或使用 Tailscale 進行隨時隨地的存取：

```bash
# 在 Pi 上執行
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# 更新設定
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## 效能最佳化

### 使用 USB SSD（大幅提升）

SD 卡速度慢且容易損耗。使用 USB SSD 可顯著提升效能：

```bash
# 檢查是否從 USB 啟動
lsblk
```

請參閱 [Pi USB 啟動指南](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) 進行設定。

### 減少記憶體使用量

```bash
# 停用 GPU 記憶體配置（Headless 模式）
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# 若不需要則停用藍牙
sudo systemctl disable bluetooth
```

### 資源監控

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

### 二進位檔案相容性

多數 OpenClaw 功能在 ARM64 上運作良好，但某些外部二進位檔案可能需要 ARM 版本：

| 工具               | ARM64 狀態 | 備註                                |
| ------------------ | ---------- | ----------------------------------- |
| Node.js            | ✅         | 運作良好                            |
| WhatsApp (Baileys) | ✅         | 純 JS，無問題                       |
| Telegram           | ✅         | 純 JS，無問題                       |
| gog (Gmail CLI)    | ⚠️         | 檢查是否有 ARM 發行版本             |
| Chromium (瀏覽器)  | ✅         | `sudo apt install chromium-browser` |

如果某個 Skills 失敗，請檢查其二進位檔案是否有 ARM 版本。許多 Go/Rust 工具都有提供，但部分則無。

### 32 位元 vs 64 位元

**務必使用 64 位元作業系統。** Node.js 和許多現代工具都需要它。使用以下指令檢查：

```bash
uname -m
# 應顯示：aarch64 (64-bit) 而非 armv7l (32-bit)
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

新手導覽精靈會設定此項，但可透過以下方式驗證：

```bash
# 檢查服務是否已啟用
sudo systemctl is-enabled openclaw

# 若未啟用則啟用它
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

# 新增更多 Swap（見步驟 5）
# 或減少在 Pi 上執行的服務
```

### 效能緩慢

- 使用 USB SSD 取代 SD 卡
- 停用未使用的服務：`sudo systemctl disable cups bluetooth avahi-daemon`
- 檢查 CPU 降頻情況：`vcgencmd get_throttled`（應返回 `0x0`）

### 服務無法啟動

```bash
# 檢查日誌
journalctl -u openclaw --no-pager -n 100

# 常見修復方法：重新構建
cd ~/openclaw  # 若使用開發者安裝
npm run build
sudo systemctl restart openclaw
```

### ARM 二進位檔案問題

如果某個 Skill 失敗並顯示 "exec format error"：

1. 檢查該二進位檔案是否有 ARM64 版本
2. 嘗試從原始碼構建
3. 或使用支援 ARM 的 Docker 容器

### WiFi 斷線

針對使用 WiFi 的 Headless Pi：

```bash
# 停用 WiFi 電源管理
sudo iwconfig wlan0 power off

# 使其永久生效
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## 成本比較

| 設定           | 一次性成本 | 每月成本 | 備註                     |
| -------------- | ---------- | -------- | ------------------------ |
| **Pi 4 (2GB)** | ~$45       | $0       | + 電費 (約 ~$5/年)       |
| **Pi 4 (4GB)** | ~$55       | $0       | 建議配置                 |
| **Pi 5 (4GB)** | ~$60       | $0       | 最佳效能                 |
| **Pi 5 (8GB)** | ~$80       | $0       | 效能過剩但能應對未來需求 |
| DigitalOcean   | $0         | $6/月    | ~$72/年                  |
| Hetzner        | $0         | €3.79/月 | ~$50/年                  |

**回本期：** 與雲端 VPS 相比，一台 Pi 在約 6-12 個月內即可回本。

---

## 延伸閱讀

- [Linux 指南](/platforms/linux) — 一般 Linux 設定
- [DigitalOcean 指南](/platforms/digitalocean) — 雲端替代方案
- [Hetzner 指南](/install/hetzner) — Docker 設定
- [Tailscale](/gateway/tailscale) — 遠端存取
- [Nodes](/nodes) — 將您的筆電/手機與 Pi Gateway 配對
