---
read_when:
  - 在 DigitalOcean 上设置 OpenClaw
  - 寻找便宜的 VPS 托管来运行 OpenClaw
summary: 在 DigitalOcean 上运行 OpenClaw（简单的付费 VPS 选项）
title: DigitalOcean
x-i18n:
  generated_at: "2026-02-03T07:51:55Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: d60559b8751da37413e5364e83c88254b476b2283386a0b07b2ca6b4e16157fc
  source_path: platforms/digitalocean.md
  workflow: 15
---

# 在 DigitalOcean 上运行 OpenClaw

## 目标

以 **$6/月**（或使用预留定价 $4/月）在 DigitalOcean 上运行持久的 OpenClaw Gateway 网关。

## 成本比较（2026）

| 提供商       | 方案          | 配置            | 价格/月     | 备注               |
| ------------ | ------------- | --------------- | ----------- | ------------------ |
| Hetzner      | CX22          | 2 vCPU、4GB RAM | €3.79 (~$4) | 最便宜的付费选项   |
| DigitalOcean | Basic         | 1 vCPU、1GB RAM | $6          | 界面简单，文档完善 |
| Vultr        | Cloud Compute | 1 vCPU、1GB RAM | $6          | 多地区可选         |
| Linode       | Nanode        | 1 vCPU、1GB RAM | $5          | 现为 Akamai 旗下   |

**选择提供商：**

- DigitalOcean：最简单的用户体验 + 可预测的设置（本指南）
- Hetzner：性价比高（参见 [Hetzner 指南](/install/hetzner)）

---

## 前提条件

- DigitalOcean 账户（[注册可获 $200 免费额度](https://m.do.co/c/signup)）
- SSH 密钥对（或愿意使用密码认证）
- 约 20 分钟

## 1) 创建 Droplet

1. 登录 [DigitalOcean](https://cloud.digitalocean.com/)
2. 点击 **Create → Droplets**
3. 选择：
   - **Region：** 离你（或你的用户）最近的地区
   - **Image：** Ubuntu 24.04 LTS
   - **Size：** Basic → Regular → **$6/mo**（1 vCPU、1GB RAM、25GB SSD）
   - **Authentication：** SSH 密钥（推荐）或密码
4. 点击 **Create Droplet**
5. 记下 IP 地址

## 2) 通过 SSH 连接

```bash
ssh root@YOUR_DROPLET_IP
```

## 3) 安装 OpenClaw

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

## 4) 运行新手引导

```bash
openclaw onboard --install-daemon
```

向导将引导你完成：

- 模型认证（API 密钥或 OAuth）
- 渠道设置（Telegram、WhatsApp、Discord 等）
- Gateway 网关令牌（自动生成）
- 守护进程安装（systemd）

## 5) 验证 Gateway 网关

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6) 访问控制面板

Gateway 网关默认绑定到 loopback。要访问控制界面：

**选项 A：SSH 隧道（推荐）**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**选项 B：Tailscale Serve（HTTPS，仅 loopback）**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

打开：`https://<magicdns>/`

注意事项：

- Serve 保持 Gateway 网关仅 loopback 并通过 Tailscale 身份头进行认证。
- 要改为需要令牌/密码，请设置 `gateway.auth.allowTailscale: false` 或使用 `gateway.auth.mode: "password"`。

**选项 C：Tailnet 绑定（不使用 Serve）**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

打开：`http://<tailscale-ip>:18789`（需要令牌）。

## 7) 连接你的渠道

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

参见[渠道](/channels)了解其他提供商。

---

## 1GB RAM 的优化

$6 的 droplet 只有 1GB RAM。为了保持运行流畅：

### 添加 swap（推荐）

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 使用更轻量的模型

如果遇到 OOM，考虑：

- 使用基于 API 的模型（Claude、GPT）而不是本地模型
- 将 `agents.defaults.model.primary` 设置为更小的模型

### 监控内存

```bash
free -h
htop
```

---

## 持久化

所有状态存储在：

- `~/.openclaw/` — 配置、凭证、会话数据
- `~/.openclaw/workspace/` — 工作区（SOUL.md、记忆等）

这些在重启后保留。定期备份：

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## 故障排除

### Gateway 网关无法启动

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### 端口已被使用

```bash
lsof -i :18789
kill <PID>
```

### 内存不足

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## 另请参阅

- [Hetzner 指南](/install/hetzner) — 更便宜、更强大
- [Docker 安装](/install/docker) — 容器化设置
- [Tailscale](/gateway/tailscale) — 安全远程访问
- [配置](/gateway/configuration) — 完整配置参考
