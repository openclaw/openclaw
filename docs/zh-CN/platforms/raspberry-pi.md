---
read_when:
  - 在 Raspberry Pi 上设置 OpenClaw 时
  - 在 ARM 设备上运行 OpenClaw 时
  - 构建低成本常驻个人 AI 时
summary: 在 Raspberry Pi 上运行 OpenClaw（低成本自托管设置）
title: Raspberry Pi
x-i18n:
  generated_at: "2026-02-03T07:53:30Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 6741eaf0115a4fa0efd6599a99e0526a20ceb30eda1d9b04cba9dd5dec84bee2
  source_path: platforms/raspberry-pi.md
  workflow: 15
---

# 在 Raspberry Pi 上运行 OpenClaw

## 目标

在 Raspberry Pi 上运行持久、常驻的 OpenClaw Gateway 网关，**一次性成本约 $35-80**（无月费）。

适用于：

- 24/7 个人 AI 助手
- 家庭自动化中心
- 低功耗、随时可用的 Telegram/WhatsApp 机器人

## 硬件要求

| Pi 型号         | 内存    | 是否可用？ | 说明                       |
| --------------- | ------- | ---------- | -------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ 最佳    | 最快，推荐                 |
| **Pi 4**        | 4GB     | ✅ 良好    | 大多数用户的最佳选择       |
| **Pi 4**        | 2GB     | ✅ 可以    | 可用，添加交换空间         |
| **Pi 4**        | 1GB     | ⚠️ 紧张    | 使用交换空间可行，最小配置 |
| **Pi 3B+**      | 1GB     | ⚠️ 慢      | 可用但较慢                 |
| **Pi Zero 2 W** | 512MB   | ❌         | 不推荐                     |

**最低配置：** 1GB 内存，1 核，500MB 磁盘  
**推荐：** 2GB+ 内存，64 位系统，16GB+ SD 卡（或 USB SSD）

## 你需要准备

- Raspberry Pi 4 或 5（推荐 2GB+）
- MicroSD 卡（16GB+）或 USB SSD（性能更好）
- 电源（推荐官方 Pi 电源）
- 网络连接（以太网或 WiFi）
- 约 30 分钟

## 1) 刷写系统

使用 **Raspberry Pi OS Lite (64-bit)** — 无头服务器不需要桌面。

1. 下载 [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. 选择系统：**Raspberry Pi OS Lite (64-bit)**
3. 点击齿轮图标（⚙️）预配置：
   - 设置主机名：`gateway-host`
   - 启用 SSH
   - 设置用户名/密码
   - 配置 WiFi（如果不使用以太网）
4. 刷写到你的 SD 卡 / USB 驱动器
5. 插入并启动 Pi

## 2) 通过 SSH 连接

```bash
ssh user@gateway-host
# 或使用 IP 地址
ssh user@192.168.x.x
```

## 3) 系统设置

```bash
# 更新系统
sudo apt update && sudo apt upgrade -y

# 安装必要软件包
sudo apt install -y git curl build-essential

# 设置时区（对 cron/提醒很重要）
sudo timedatectl set-timezone America/Chicago  # 改成你的时区
```

## 4) 安装 Node.js 22（ARM64）

```bash
# 通过 NodeSource 安装 Node.js
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 验证
node --version  # 应显示 v22.x.x
npm --version
```

## 5) 添加交换空间（2GB 或更少内存时很重要）

交换空间可防止内存不足崩溃：

```bash
# 创建 2GB 交换文件
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# 永久生效
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 优化低内存（降低 swappiness）
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 6) 安装 OpenClaw

### 选项 A：标准安装（推荐）

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### 选项 B：可修改安装（用于调试）

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

可修改安装让你可以直接访问日志和代码 — 对调试 ARM 特定问题很有用。

## 7) 运行新手引导

```bash
openclaw onboard --install-daemon
```

按照向导操作：

1. **Gateway 网关模式：** Local
2. **认证：** 推荐 API 密钥（OAuth 在无头 Pi 上可能不稳定）
3. **渠道：** Telegram 最容易上手
4. **守护进程：** 是（systemd）

## 8) 验证安装

```bash
# 检查状态
openclaw status

# 检查服务
sudo systemctl status openclaw

# 查看日志
journalctl -u openclaw -f
```

## 9) 访问仪表板

由于 Pi 是无头的，使用 SSH 隧道：

```bash
# 从你的笔记本电脑/台式机
ssh -L 18789:localhost:18789 user@gateway-host

# 然后在浏览器中打开
open http://localhost:18789
```

或使用 Tailscale 实现常驻访问：

```bash
# 在 Pi 上
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# 更新配置
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## 性能优化

### 使用 USB SSD（巨大改进）

SD 卡速度慢且会磨损。USB SSD 可大幅提升性能：

```bash
# 检查是否从 USB 启动
lsblk
```

设置请参见 [Pi USB 启动指南](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot)。

### 减少内存使用

```bash
# 禁用 GPU 内存分配（无头模式）
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# 如不需要则禁用蓝牙
sudo systemctl disable bluetooth
```

### 监控资源

```bash
# 检查内存
free -h

# 检查 CPU 温度
vcgencmd measure_temp

# 实时监控
htop
```

---

## ARM 特定说明

### 二进制兼容性

大多数 OpenClaw 功能在 ARM64 上可用，但某些外部二进制文件可能需要 ARM 构建：

| 工具               | ARM64 状态 | 说明                                |
| ------------------ | ---------- | ----------------------------------- |
| Node.js            | ✅         | 运行良好                            |
| WhatsApp (Baileys) | ✅         | 纯 JS，无问题                       |
| Telegram           | ✅         | 纯 JS，无问题                       |
| gog (Gmail CLI)    | ⚠️         | 检查是否有 ARM 版本                 |
| Chromium (browser) | ✅         | `sudo apt install chromium-browser` |

如果某个 skill 失败，检查其二进制文件是否有 ARM 构建。许多 Go/Rust 工具有；有些没有。

### 32 位 vs 64 位

**始终使用 64 位系统。** Node.js 和许多现代工具需要它。使用以下命令检查：

```bash
uname -m
# 应显示：aarch64（64 位）而不是 armv7l（32 位）
```

---

## 推荐的模型设置

由于 Pi 只是 Gateway 网关（模型在云端运行），使用基于 API 的模型：

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

**不要尝试在 Pi 上运行本地 LLM** — 即使是小模型也太慢了。让 Claude/GPT 来做繁重的工作。

---

## 开机自启

新手引导向导会设置这个，但要验证：

```bash
# 检查服务是否已启用
sudo systemctl is-enabled openclaw

# 如果没有则启用
sudo systemctl enable openclaw

# 开机启动
sudo systemctl start openclaw
```

---

## 故障排除

### 内存不足（OOM）

```bash
# 检查内存
free -h

# 添加更多交换空间（见步骤 5）
# 或减少 Pi 上运行的服务
```

### 性能慢

- 使用 USB SSD 代替 SD 卡
- 禁用未使用的服务：`sudo systemctl disable cups bluetooth avahi-daemon`
- 检查 CPU 降频：`vcgencmd get_throttled`（应返回 `0x0`）

### 服务无法启动

```bash
# 检查日志
journalctl -u openclaw --no-pager -n 100

# 常见修复：重新构建
cd ~/openclaw  # 如果使用可修改安装
npm run build
sudo systemctl restart openclaw
```

### ARM 二进制问题

如果某个 skill 失败并显示"exec format error"：

1. 检查该二进制文件是否有 ARM64 构建
2. 尝试从源代码构建
3. 或使用支持 ARM 的 Docker 容器

### WiFi 断开

对于使用 WiFi 的无头 Pi：

```bash
# 禁用 WiFi 电源管理
sudo iwconfig wlan0 power off

# 永久生效
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## 成本对比

| 设置           | 一次性成本 | 月费     | 说明               |
| -------------- | ---------- | -------- | ------------------ |
| **Pi 4 (2GB)** | ~$45       | $0       | + 电费（约 $5/年） |
| **Pi 4 (4GB)** | ~$55       | $0       | 推荐               |
| **Pi 5 (4GB)** | ~$60       | $0       | 最佳性能           |
| **Pi 5 (8GB)** | ~$80       | $0       | 过剩但面向未来     |
| DigitalOcean   | $0         | $6/月    | $72/年             |
| Hetzner        | $0         | €3.79/月 | 约 $50/年          |

**回本期：** 与云 VPS 相比，Pi 约 6-12 个月内回本。

---

## 另请参阅

- [Linux 指南](/platforms/linux) — 通用 Linux 设置
- [DigitalOcean 指南](/platforms/digitalocean) — 云替代方案
- [Hetzner 指南](/install/hetzner) — Docker 设置
- [Tailscale](/gateway/tailscale) — 远程访问
- [节点](/nodes) — 将你的笔记本电脑/手机与 Pi Gateway 网关配对
