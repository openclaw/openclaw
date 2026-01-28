---
read_when:
  - 在 DigitalOcean 上设置 OpenClaw
  - 寻找便宜的 VPS 托管来运行 OpenClaw
summary: 在 DigitalOcean 上运行 OpenClaw（简单的付费 VPS 方案）
title: DigitalOcean
x-i18n:
  generated_at: "2026-02-01T21:20:02Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: d60559b8751da37413e5364e83c88254b476b2283386a0b07b2ca6b4e16157fc
  source_path: platforms/digitalocean.md
  workflow: 15
---

# 在 DigitalOcean 上运行 OpenClaw

## 目标

在 DigitalOcean 上运行持久化的 OpenClaw Gateway网关，费用为**每月 $6**（预留定价为每月 $4）。

如果你想要每月 $0 的方案且不介意 ARM + 特定提供商的设置，请参阅 [Oracle Cloud 指南](/platforms/oracle)。

## 费用对比（2026）

| 提供商       | 方案            | 规格                  | 月费        | 备注                       |
| ------------ | --------------- | --------------------- | ----------- | -------------------------- |
| Oracle Cloud | Always Free ARM | 最高 4 OCPU, 24GB RAM | $0          | ARM，容量有限 / 注册较繁琐 |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM       | €3.79 (~$4) | 最便宜的付费方案           |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM       | $6          | 界面简洁，文档完善         |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM       | $6          | 节点位置多                 |
| Linode       | Nanode          | 1 vCPU, 1GB RAM       | $5          | 现为 Akamai 旗下           |

**选择提供商：**

- DigitalOcean：最简单的用户体验 + 可预期的设置流程（本指南）
- Hetzner：性价比高（参见 [Hetzner 指南](/platforms/hetzner)）
- Oracle Cloud：可以每月 $0，但配置较繁琐且仅支持 ARM（参见 [Oracle 指南](/platforms/oracle)）

---

## 前提条件

- DigitalOcean 账户（[注册可获 $200 免费额度](https://m.do.co/c/signup)）
- SSH 密钥对（或愿意使用密码认证）
- 约 20 分钟

## 1）创建 Droplet

1. 登录 [DigitalOcean](https://cloud.digitalocean.com/)
2. 点击 **Create → Droplets**
3. 选择：
   - **区域：** 离你（或你的用户）最近的
   - **镜像：** Ubuntu 24.04 LTS
   - **规格：** Basic → Regular → **$6/月**（1 vCPU, 1GB RAM, 25GB SSD）
   - **认证：** SSH 密钥（推荐）或密码
4. 点击 **Create Droplet**
5. 记下 IP 地址

## 2）通过 SSH 连接

```bash
ssh root@YOUR_DROPLET_IP
```

## 3）安装 OpenClaw

```bash
# 更新系统
apt update && apt upgrade -y

# 安装 Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# 安装 OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# 验证
openclaw --version
```

## 4）运行新手引导

```bash
openclaw onboard --install-daemon
```

向导将引导你完成：

- 模型认证（API 密钥或 OAuth）
- 渠道设置（Telegram、WhatsApp、Discord 等）
- Gateway网关令牌（自动生成）
- 守护进程安装（systemd）

## 5）验证 Gateway网关

```bash
# 检查状态
openclaw status

# 检查服务
systemctl --user status openclaw-gateway.service

# 查看日志
journalctl --user -u openclaw-gateway.service -f
```

## 6）访问控制面板

Gateway网关默认绑定到 local loopback。要访问控制面板 UI：

**方案 A：SSH 隧道（推荐）**

```bash
# 从你的本地机器
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# 然后打开：http://localhost:18789
```

**方案 B：Tailscale Serve（HTTPS，仅 local loopback）**

```bash
# 在 Droplet 上
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# 配置 Gateway网关使用 Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

打开：`https://<magicdns>/`

注意事项：

- Serve 保持 Gateway网关仅绑定 local loopback，并通过 Tailscale 身份头进行认证。
- 如需使用令牌/密码认证，请设置 `gateway.auth.allowTailscale: false` 或使用 `gateway.auth.mode: "password"`。

**方案 C：Tailnet 绑定（不使用 Serve）**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

打开：`http://<tailscale-ip>:18789`（需要令牌）。

## 7）连接你的渠道

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# 扫描二维码
```

其他提供商请参阅[渠道](/channels)。

---

## 1GB RAM 的优化建议

$6 的 Droplet 只有 1GB RAM。为保持运行流畅：

### 添加交换空间（推荐）

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 使用更轻量的模型

如果遇到内存不足（OOM），可以考虑：

- 使用基于 API 的模型（Claude、GPT）而非本地模型
- 将 `agents.defaults.model.primary` 设置为更小的模型

### 监控内存

```bash
free -h
htop
```

---

## 持久化

所有状态存储在：

- `~/.openclaw/` — 配置、凭据、会话数据
- `~/.openclaw/workspace/` — 工作区（SOUL.md、记忆等）

这些内容在重启后不会丢失。定期备份：

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Oracle Cloud 免费替代方案

Oracle Cloud 提供 **Always Free** ARM 实例，性能远超此处任何付费方案——每月 $0。

| 你将获得       | 规格             |
| -------------- | ---------------- |
| **4 OCPU**     | ARM Ampere A1    |
| **24GB RAM**   | 绰绰有余         |
| **200GB 存储** | 块存储卷         |
| **永久免费**   | 不会扣信用卡费用 |

**注意事项：**

- 注册过程可能较繁琐（失败时请重试）
- ARM 架构——大多数工具可正常工作，但部分二进制文件需要 ARM 构建版本

完整设置指南请参阅 [Oracle Cloud](/platforms/oracle)。注册技巧和注册流程故障排除请参阅此[社区指南](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)。

---

## 故障排除

### Gateway网关无法启动

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### 端口已被占用

```bash
lsof -i :18789
kill <PID>
```

### 内存不足

```bash
# 检查内存
free -h

# 添加更多交换空间
# 或升级到 $12/月的 Droplet（2GB RAM）
```

---

## 另请参阅

- [Hetzner 指南](/platforms/hetzner) — 更便宜，性能更强
- [Docker 安装](/install/docker) — 容器化设置
- [Tailscale](/gateway/tailscale) — 安全远程访问
- [配置](/gateway/configuration) — 完整配置参考
