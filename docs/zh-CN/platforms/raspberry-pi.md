---
read_when:
  - 在 Raspberry Pi 上设置 OpenClaw
  - 在 ARM 设备上运行 OpenClaw
  - 搭建低成本的全天候个人 AI
summary: 在 Raspberry Pi 上运行 OpenClaw（低成本自托管方案）
title: Raspberry Pi
x-i18n:
  generated_at: "2026-02-01T21:34:34Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 6741eaf0115a4fa0efd6599a99e0526a20ceb30eda1d9b04cba9dd5dec84bee2
  source_path: platforms/raspberry-pi.md
  workflow: 15
---

# 在 Raspberry Pi 上运行 OpenClaw

## 目标

在 Raspberry Pi 上运行一个持久的、全天候在线的 OpenClaw Gateway网关，**一次性费用约 $35-80**（无月费）。

适用场景：

- 24/7 个人 AI 助手
- 家庭自动化中枢
- 低功耗、随时可用的 Telegram/WhatsApp 机器人

## 硬件要求

| Pi 型号         | 内存    | 可用？  | 备注                           |
| --------------- | ------- | ------- | ------------------------------ |
| **Pi 5**        | 4GB/8GB | ✅ 最佳 | 速度最快，推荐                 |
| **Pi 4**        | 4GB     | ✅ 良好 | 大多数用户的最佳性价比         |
| **Pi 4**        | 2GB     | ✅ 可用 | 可运行，需添加交换空间         |
| **Pi 4**        | 1GB     | ⚠️ 紧张 | 需交换空间和最小化配置才可运行 |
| **Pi 3B+**      | 1GB     | ⚠️ 缓慢 | 可运行但较卡顿                 |
| **Pi Zero 2 W** | 512MB   | ❌      | 不推荐                         |

**最低配置：** 1GB 内存，1 核，500MB 磁盘空间
**推荐配置：** 2GB+ 内存，64 位系统，16GB+ SD 卡（或 USB SSD）

## 你需要准备

- Raspberry Pi 4 或 5（推荐 2GB+ 内存）
- MicroSD 卡（16GB+）或 USB SSD（性能更好）
- 电源适配器（推荐官方 Pi 电源）
- 网络连接（以太网或 WiFi）
- 约 30 分钟时间

## 1) 刷写系统

使用 **Raspberry Pi OS Lite (64-bit)** — 无桌面的无头服务器无需桌面环境。

1. 下载 [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. 选择系统：**Raspberry Pi OS Lite (64-bit)**
3. 点击齿轮图标（⚙️）预配置：
   - 设置主机名：`gateway-host`
   - 启用 SSH
   - 设置用户名/密码
   - 配置 WiFi（如果不使用以太网）
4. 刷写到 SD 卡 / USB 驱动器
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

# 设置时区（对定时任务/提醒很重要）
sudo timedatectl set-timezone America/Chicago  # 改为你的时区
```

## 4) 安装 Node.js 22 (ARM64)

```bash
# 通过 NodeSource 安装 Node.js
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 验证
node --version  # 应显示 v22.x.x
npm --version
```

## 5) 添加交换空间（2GB 及以下内存必做）

交换空间可防止内存不足导致的崩溃：

```bash
# 创建 2GB 交换文件
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# 设为永久生效
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 针对低内存优化（降低 swappiness）
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 6) 安装 OpenClaw

### 方案 A：标准安装（推荐）

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### 方案 B：可修改安装（适合折腾）

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

1. **Gateway网关模式：** 本地
2. **认证：** 推荐使用 API 密钥（OAuth 在无头 Pi 上可能不太稳定）
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

## 9) 访问仪表盘

由于 Pi 是无头模式，使用 SSH 隧道：

```bash
# 从你的笔记本/台式机
ssh -L 18789:localhost:18789 user@gateway-host

# 然后在浏览器中打开
open http://localhost:18789
```

或使用 Tailscale 实现全天候访问：

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

### 使用 USB SSD（显著提升）

SD 卡速度慢且易损耗。USB SSD 能大幅提升性能：

```bash
# 检查是否从 USB 启动
lsblk
```

设置方法请参阅 [Pi USB 启动指南](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot)。

### 减少内存占用

```bash
# 禁用 GPU 内存分配（无头模式）
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# 如不需要蓝牙则禁用
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

大多数 OpenClaw 功能在 ARM64 上正常工作，但部分外部二进制文件可能需要 ARM 构建版本：

| 工具               | ARM64 状态 | 备注                                |
| ------------------ | ---------- | ----------------------------------- |
| Node.js            | ✅         | 运行良好                            |
| WhatsApp (Baileys) | ✅         | 纯 JS，无问题                       |
| Telegram           | ✅         | 纯 JS，无问题                       |
| gog (Gmail CLI)    | ⚠️         | 请检查是否有 ARM 版本               |
| Chromium (browser) | ✅         | `sudo apt install chromium-browser` |

如果某个 Skills 运行失败，请检查其二进制文件是否有 ARM 构建版本。大多数 Go/Rust 工具有；部分没有。

### 32 位 vs 64 位

**务必使用 64 位系统。** Node.js 和许多现代工具都需要 64 位。检查方法：

```bash
uname -m
# 应显示：aarch64（64 位）而非 armv7l（32 位）
```

---

## 推荐模型配置

由于 Pi 只是 Gateway网关（模型在云端运行），请使用基于 API 的模型：

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

**不要尝试在 Pi 上运行本地大语言模型** — 即使是小模型也太慢。让 Claude/GPT 来完成繁重的工作。

---

## 开机自启动

新手引导向导会自动设置，但可以验证一下：

```bash
# 检查服务是否已启用
sudo systemctl is-enabled openclaw

# 如未启用则启用
sudo systemctl enable openclaw

# 开机启动
sudo systemctl start openclaw
```

---

## 故障排除

### 内存不足 (OOM)

```bash
# 检查内存
free -h

# 添加更多交换空间（参见步骤 5）
# 或减少 Pi 上运行的服务
```

### 性能缓慢

- 使用 USB SSD 替代 SD 卡
- 禁用未使用的服务：`sudo systemctl disable cups bluetooth avahi-daemon`
- 检查 CPU 降频：`vcgencmd get_throttled`（应返回 `0x0`）

### 服务无法启动

```bash
# 检查日志
journalctl -u openclaw --no-pager -n 100

# 常见修复方法：重新构建
cd ~/openclaw  # 如果使用可修改安装
npm run build
sudo systemctl restart openclaw
```

### ARM 二进制问题

如果某个 Skills 报错 "exec format error"：

1. 检查该二进制文件是否有 ARM64 构建版本
2. 尝试从源码编译
3. 或使用支持 ARM 的 Docker 容器

### WiFi 断连

对于使用 WiFi 的无头 Pi：

```bash
# 禁用 WiFi 电源管理
sudo iwconfig wlan0 power off

# 设为永久生效
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## 成本对比

| 方案           | 一次性费用 | 月费     | 备注               |
| -------------- | ---------- | -------- | ------------------ |
| **Pi 4 (2GB)** | ~$45       | $0       | + 电费（约 $5/年） |
| **Pi 4 (4GB)** | ~$55       | $0       | 推荐               |
| **Pi 5 (4GB)** | ~$60       | $0       | 最佳性能           |
| **Pi 5 (8GB)** | ~$80       | $0       | 过剩但面向未来     |
| DigitalOcean   | $0         | $6/月    | $72/年             |
| Hetzner        | $0         | €3.79/月 | 约 $50/年          |

**回本周期：** 与云 VPS 相比，Pi 约 6-12 个月即可回本。

---

## 另请参阅

- [Linux 指南](/platforms/linux) — 通用 Linux 设置
- [DigitalOcean 指南](/platforms/digitalocean) — 云端替代方案
- [Hetzner 指南](/platforms/hetzner) — Docker 设置
- [Tailscale](/gateway/tailscale) — 远程访问
- [节点](/nodes) — 将你的笔记本/手机与 Pi Gateway网关配对
