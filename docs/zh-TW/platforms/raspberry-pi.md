---
summary: OpenClaw on Raspberry Pi (budget self-hosted setup)
read_when:
  - Setting up OpenClaw on a Raspberry Pi
  - Running OpenClaw on ARM devices
  - Building a cheap always-on personal AI
title: Raspberry Pi
---

# OpenClaw 在 Raspberry Pi 上的使用

## 目標

在 Raspberry Pi 上執行持續、隨時開啟的 OpenClaw Gateway，**一次性花費約 35-80 美元**（無月費）。

非常適合：

- 24/7 個人 AI 助理
- 智慧家庭自動化中心
- 低功耗、隨時可用的 Telegram/WhatsApp 機器人

## 硬體需求

| Pi 型號         | 記憶體  | 適用性    | 備註                       |
| --------------- | ------- | --------- | -------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ 最佳   | 速度最快，推薦使用         |
| **Pi 4**        | 4GB     | ✅ 良好   | 大多數使用者的最佳選擇     |
| **Pi 4**        | 2GB     | ✅ 可用   | 可用，建議加裝 swap        |
| **Pi 4**        | 1GB     | ⚠️ 緊湊   | 可用，需 swap 且設定最小化 |
| **Pi 3B+**      | 1GB     | ⚠️ 慢     | 可用但較慢                 |
| **Pi Zero 2 W** | 512MB   | ❌ 不建議 | 不建議使用                 |

**最低規格：** 1GB 記憶體、1 核心、500MB 磁碟空間  
**建議規格：** 2GB 以上記憶體、64 位元作業系統、16GB 以上 SD 卡（或 USB SSD）

## 你需要準備

- Raspberry Pi 4 或 5（建議 2GB 以上）
- MicroSD 卡（16GB 以上）或 USB SSD（效能較佳）
- 電源供應器（建議官方 Pi 電源）
- 網路連線（有線或 WiFi）
- 約 30 分鐘時間

## 1) 燒錄作業系統

使用 **Raspberry Pi OS Lite (64-bit)** — 無需桌面環境，適合無頭伺服器。

1. 下載 [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. 選擇作業系統：**Raspberry Pi OS Lite (64-bit)**
3. 點擊齒輪圖示 (⚙️) 進行預先設定：
   - 設定主機名稱：`gateway-host`
   - 啟用 SSH
   - 設定使用者名稱/密碼
   - 設定 WiFi（若未使用有線網路）
4. 燒錄至 SD 卡或 USB 裝置
5. 插入並啟動 Pi

## 2) 透過 SSH 連線

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3) 系統設定

bash

# 更新系統

sudo apt update && sudo apt upgrade -y

# 安裝必要套件

sudo apt install -y git curl build-essential

# 設定時區（對 cron/提醒功能很重要）

sudo timedatectl set-timezone America/Chicago # 請改成你的時區

## 4) 安裝 Node.js 24 (ARM64)

bash

# 透過 NodeSource 安裝 Node.js

curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs

# 驗證安裝

node --version # 應顯示 v24.x.x
npm --version

## 5) 新增 Swap（2GB 或以下系統很重要）

Swap 可防止記憶體不足導致的當機：

bash

# 建立 2GB swap 檔案

sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# 設定永久啟用

echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 針對低記憶體優化（降低 swappiness）

echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p

## 6) 安裝 OpenClaw

### 選項 A：標準安裝（推薦）

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### 選項 B：可修改安裝（適合試玩）

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

可修改安裝讓你能直接存取日誌和程式碼 — 對於除錯 ARM 特定問題非常有用。

## 7) 執行新手引導

```bash
openclaw onboard --install-daemon
```

依照精靈指示操作：

1. **閘道模式：** 本地
2. **認證：** 建議使用 API 金鑰（OAuth 在無頭 Pi 上可能不太穩定）
3. **頻道：** Telegram 是最容易入門的
4. **守護程序：** 是（systemd）

## 8) 驗證安裝

bash

# 檢查狀態

openclaw status

# 檢查服務

sudo systemctl status openclaw

# 查看日誌

journalctl -u openclaw -f

## 9) 存取 OpenClaw 儀表板

將 `user@gateway-host` 替換成你的 Pi 使用者名稱和主機名稱或 IP 位址。

在你的電腦上，請 Pi 輸出最新的儀表板 URL：

```bash
ssh user@gateway-host 'openclaw dashboard --no-open'
```

該指令會列印出 `Dashboard URL:`。根據 `gateway.auth.token` 的設定，URL 可能是純粹的 `http://127.0.0.1:18789/` 連結，或是包含 `#token=...` 的連結。

在你電腦的另一個終端機中，建立 SSH 隧道：

```bash
ssh -N -L 18789:127.0.0.1:18789 user@gateway-host
```

接著在本機瀏覽器中開啟列印出的 Dashboard URL。

如果介面要求驗證，請將 `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）中的 token 貼到 Control UI 設定中。

若要持續遠端存取，請參考 [Tailscale](/gateway/tailscale)。

---

## 效能優化

### 使用 USB SSD（大幅提升）

SD 卡速度慢且容易損耗。使用 USB SSD 可大幅提升效能：

```bash
# Check if booting from USB
lsblk
```

請參考 [Pi USB 開機指南](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) 進行設定。

### 加快 CLI 啟動速度（模組編譯快取）

在較低效能的 Pi 主機上，啟用 Node 的模組編譯快取，讓重複執行 CLI 時更快：

```bash
grep -q 'NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache' ~/.bashrc || cat >> ~/.bashrc <<'EOF' # pragma: allowlist secret
export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
mkdir -p /var/tmp/openclaw-compile-cache
export OPENCLAW_NO_RESPAWN=1
EOF
source ~/.bashrc
```

備註：

- `NODE_COMPILE_CACHE` 加速後續執行 (`status`、`health`、`--help`)。
- `/var/tmp` 比 `/tmp` 更能在重啟後保持狀態。
- `OPENCLAW_NO_RESPAWN=1` 避免 CLI 自我重啟帶來的額外啟動成本。
- 第一次執行會預熱快取；後續執行受益最大。

### systemd 啟動調校（可選）

如果這台 Pi 主要執行 OpenClaw，請新增服務 drop-in 以減少重啟抖動並保持啟動環境穩定：

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

接著執行：

```bash
sudo systemctl daemon-reload
sudo systemctl restart openclaw
```

若可能，請將 OpenClaw 狀態/快取放在 SSD 支援的儲存裝置上，以避免冷啟動時 SD 卡隨機 I/O 瓶頸。

`Restart=` 政策如何協助自動恢復：
[systemd 可自動化服務恢復](https://www.redhat.com/en/blog/systemd-automate-recovery)。

### 減少記憶體使用量

bash

# 停用 GPU 記憶體分配（無頭模式）

echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# 若不需要，停用藍牙

sudo systemctl disable bluetooth

### 監控資源

bash

# 檢查記憶體

free -h

# 檢查 CPU 溫度

vcgencmd measure_temp

# 即時監控

htop

---

## ARM 專屬說明

### 二進位相容性

大部分 OpenClaw 功能在 ARM64 上可用，但部分外部二進位檔可能需要 ARM 版本：

| 工具               | ARM64 狀態 | 備註                                |
| ------------------ | ---------- | ----------------------------------- |
| Node.js            | ✅         | 運作良好                            |
| WhatsApp (Baileys) | ✅         | 純 JS，無問題                       |
| Telegram           | ✅         | 純 JS，無問題                       |
| gog (Gmail CLI)    | ⚠️         | 請確認是否有 ARM 版本               |
| Chromium (瀏覽器)  | ✅         | `sudo apt install chromium-browser` |

若某個技能失敗，請確認其二進位檔是否有 ARM 版本。許多 Go/Rust 工具有，但部分沒有。

### 32 位元 vs 64 位元

**務必使用 64 位元作業系統。** Node.js 及許多現代工具都需要。可用以下指令確認：

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## 推薦的模型設定

由於 Pi 僅作為 Gateway（模型執行於雲端），建議使用基於 API 的模型：

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

**不要嘗試在 Pi 上執行本地 LLM** — 即使是小型模型也太慢了。讓 Claude/GPT 來處理繁重的運算。

---

## 開機自動啟動

入門精靈會自動設定，但你可以這樣確認：

bash

# 檢查服務是否已啟用

sudo systemctl is-enabled openclaw

# 如果沒有啟用，請執行

sudo systemctl enable openclaw

# 設定開機啟動

sudo systemctl start openclaw

---

## 疑難排解

### 記憶體不足 (OOM)

bash

# 檢查記憶體

free -h

# 增加 swap 空間（參考步驟 5）

# 或減少 Pi 上執行的服務數量

### 執行效能緩慢

- 使用 USB SSD 替代 SD 卡
- 停用未使用的服務：`sudo systemctl disable cups bluetooth avahi-daemon`
- 檢查 CPU 節流狀況：`vcgencmd get_throttled`（應回傳 `0x0`）

### 服務無法啟動

bash

# 查看日誌

journalctl -u openclaw --no-pager -n 100

# 常見修復：重新編譯

cd ~/openclaw # 如果使用可修改安裝版
npm run build
sudo systemctl restart openclaw

### ARM 二進位檔問題

如果技能執行失敗並出現「exec format error」：

1. 檢查該二進位檔是否有 ARM64 版本
2. 嘗試從原始碼編譯
3. 或使用支援 ARM 的 Docker 容器

### WiFi 斷線問題

針對無螢幕的 Pi 使用 WiFi：

bash

# 關閉 WiFi 電源管理

sudo iwconfig wlan0 power off

# 設為永久生效

echo 'wireless-power off' | sudo tee -a /etc/network/interfaces

---

## 成本比較

| 設備           | 一次性成本  | 月費     | 備註               |
| -------------- | ----------- | -------- | ------------------ |
| **Pi 4 (2GB)** | 約 $45 美元 | $0       | + 電費（約 $5/年） |
| **Pi 4 (4GB)** | 約 $55 美元 | $0       | 推薦款             |
| **Pi 5 (4GB)** | 約 $60 美元 | $0       | 最佳效能           |
| **Pi 5 (8GB)** | 約 $80 美元 | $0       | 過度設定但具未來性 |
| DigitalOcean   | $0          | $6/月    | $72/年             |
| Hetzner        | $0          | €3.79/月 | 約 $50/年          |

**回本時間：** 使用 Pi 約 6-12 個月即可抵銷雲端 VPS 成本。

---

## 參考資料

- [Linux 指南](/platforms/linux) — 一般 Linux 設定
- [DigitalOcean 指南](/platforms/digitalocean) — 雲端替代方案
- [Hetzner 指南](/install/hetzner) — Docker 設定
- [Tailscale](/gateway/tailscale) — 遠端存取
- [節點](/nodes) — 將你的筆電/手機與 Pi 閘道配對
