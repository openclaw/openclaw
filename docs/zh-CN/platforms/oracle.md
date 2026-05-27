---
read_when:
  - 在 Oracle Cloud 上设置 OpenClaw
  - 寻找 OpenClaw 的低成本 VPS 托管
  - 想要在小型服务器上 24/7 运行 OpenClaw
summary: 在 Oracle Cloud 上运行 OpenClaw（Always Free ARM）
title: Oracle Cloud
x-i18n:
  generated_at: "2026-02-03T07:53:25Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: d3cc337b40ea512b5756ac15ec4341fecad417ede75f717fea3035678c7c6697
  source_path: platforms/oracle.md
  workflow: 15
---

# 在 Oracle Cloud（OCI）上运行 OpenClaw

## 目标

在 Oracle Cloud 的 **Always Free** ARM 层上运行持久化的 OpenClaw Gateway 网关。

Oracle 的免费层非常适合 OpenClaw（特别是如果你已经有 OCI 账户），但有一些权衡：

- ARM 架构（大多数东西都能工作，但某些二进制文件可能仅支持 x86）
- 容量和注册可能比较麻烦

## 成本比较（2026）

| 提供商       | 方案            | 配置                  | 价格/月 | 说明                 |
| ------------ | --------------- | --------------------- | ------- | -------------------- |
| Oracle Cloud | Always Free ARM | 最多 4 OCPU，24GB RAM | $0      | ARM，容量有限        |
| Hetzner      | CX22            | 2 vCPU，4GB RAM       | ~ $4    | 最便宜的付费选项     |
| DigitalOcean | Basic           | 1 vCPU，1GB RAM       | $6      | 易用的 UI，文档完善  |
| Vultr        | Cloud Compute   | 1 vCPU，1GB RAM       | $6      | 多个地区             |
| Linode       | Nanode          | 1 vCPU，1GB RAM       | $5      | 现为 Akamai 的一部分 |

---

## 先决条件

- Oracle Cloud 账户（[注册](https://www.oracle.com/cloud/free/)）——如果遇到问题请参阅[社区注册指南](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)
- Tailscale 账户（在 [tailscale.com](https://tailscale.com) 免费）
- 约 30 分钟

## 1) 创建 OCI 实例

1. 登录 [Oracle Cloud Console](https://cloud.oracle.com/)
2. 导航到 **Compute → Instances → Create Instance**
3. 配置：
   - **Name:** `openclaw`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex`（Ampere ARM）
   - **OCPUs:** 2（或最多 4）
   - **Memory:** 12 GB（或最多 24 GB）
   - **Boot volume:** 50 GB（最多 200 GB 免费）
   - **SSH key:** 添加你的公钥
4. 点击 **Create**
5. 记录公网 IP 地址

**提示：** 如果实例创建失败并显示"Out of capacity"，尝试不同的可用性域或稍后重试。免费层容量有限。

## 2) 连接并更新

```bash
# 通过公网 IP 连接
ssh ubuntu@YOUR_PUBLIC_IP

# 更新系统
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**注意：** `build-essential` 是某些依赖项 ARM 编译所必需的。

## 3) 配置用户和主机名

```bash
# 设置主机名
sudo hostnamectl set-hostname openclaw

# 为 ubuntu 用户设置密码
sudo passwd ubuntu

# 启用 lingering（注销后保持用户服务运行）
sudo loginctl enable-linger ubuntu
```

## 4) 安装 Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

这会启用 Tailscale SSH，所以你可以从 tailnet 上的任何设备通过 `ssh openclaw` 连接——不需要公网 IP。

验证：

```bash
tailscale status
```

**从现在开始，通过 Tailscale 连接：** `ssh ubuntu@openclaw`（或使用 Tailscale IP）。

## 5) 安装 OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

当提示"How do you want to hatch your bot?"时，选择 **"Do this later"**。

> 注意：如果你遇到 ARM 原生构建问题，在使用 Homebrew 之前先从系统包开始（例如 `sudo apt install -y build-essential`）。

## 6) 配置 Gateway 网关（loopback + 令牌认证）并启用 Tailscale Serve

使用令牌认证作为默认值。它是可预测的，避免需要任何"不安全认证"的控制 UI 标志。

```bash
# 在 VM 上保持 Gateway 网关私有
openclaw config set gateway.bind loopback

# 要求 Gateway 网关 + 控制 UI 的认证
openclaw config set gateway.auth.mode token
openclaw doctor --generate-gateway-token

# 通过 Tailscale Serve 暴露（HTTPS + tailnet 访问）
openclaw config set gateway.tailscale.mode serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

systemctl --user restart openclaw-gateway
```

## 7) 验证

```bash
# 检查版本
openclaw --version

# 检查守护进程状态
systemctl --user status openclaw-gateway

# 检查 Tailscale Serve
tailscale serve status

# 测试本地响应
curl http://localhost:18789
```

## 8) 锁定 VCN 安全

现在一切正常工作了，锁定 VCN 以阻止除 Tailscale 之外的所有流量。OCI 的虚拟云网络充当网络边缘的防火墙——流量在到达你的实例之前就被阻止。

1. 在 OCI Console 中转到 **Networking → Virtual Cloud Networks**
2. 点击你的 VCN → **Security Lists** → Default Security List
3. **移除**除以下之外的所有入站规则：
   - `0.0.0.0/0 UDP 41641`（Tailscale）
4. 保留默认出站规则（允许所有出站）

这会在网络边缘阻止端口 22 上的 SSH、HTTP、HTTPS 和其他所有内容。从现在开始，你只能通过 Tailscale 连接。

---

## 访问控制 UI

从你 Tailscale 网络上的任何设备：

```
https://openclaw.<tailnet-name>.ts.net/
```

将 `<tailnet-name>` 替换为你的 tailnet 名称（在 `tailscale status` 中可见）。

不需要 SSH 隧道。Tailscale 提供：

- HTTPS 加密（自动证书）
- 通过 Tailscale 身份认证
- 从 tailnet 上的任何设备（笔记本电脑、手机等）访问

---

## 安全：VCN + Tailscale（推荐基线）

通过锁定 VCN（仅开放 UDP 41641）并将 Gateway 网关绑定到 loopback，你获得了强大的纵深防御：公共流量在网络边缘被阻止，管理访问通过你的 tailnet 进行。

此设置通常消除了纯粹为了阻止互联网范围的 SSH 暴力破解而需要额外的基于主机的防火墙规则的*需求*——但你仍应保持操作系统更新，运行 `openclaw security audit`，并验证你没有意外地在公共接口上监听。

### 已经受保护的内容

| 传统步骤        | 是否需要？ | 原因                                             |
| --------------- | ---------- | ------------------------------------------------ |
| UFW 防火墙      | 否         | VCN 在流量到达实例之前就阻止了                   |
| fail2ban        | 否         | 如果端口 22 在 VCN 被阻止则无暴力破解            |
| sshd 加固       | 否         | Tailscale SSH 不使用 sshd                        |
| 禁用 root 登录  | 否         | Tailscale 使用 Tailscale 身份，而不是系统用户    |
| 仅 SSH 密钥认证 | 否         | Tailscale 通过你的 tailnet 认证                  |
| IPv6 加固       | 通常不需要 | 取决于你的 VCN/子网设置；验证实际分配/暴露的内容 |

### 仍然推荐

- **凭证权限：** `chmod 700 ~/.openclaw`
- **安全审计：** `openclaw security audit`
- **系统更新：** 定期 `sudo apt update && sudo apt upgrade`
- **监控 Tailscale：** 在 [Tailscale 管理控制台](https://login.tailscale.com/admin) 中查看设备

### 验证安全态势

```bash
# 确认没有公共端口在监听
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# 验证 Tailscale SSH 处于活动状态
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# 可选：完全禁用 sshd
sudo systemctl disable --now ssh
```

---

## 备用方案：SSH 隧道

如果 Tailscale Serve 不工作，使用 SSH 隧道：

```bash
# 从你的本地机器（通过 Tailscale）
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

然后打开 `http://localhost:18789`。

---

## 故障排除

### 实例创建失败（"Out of capacity"）

免费层 ARM 实例很受欢迎。尝试：

- 不同的可用性域
- 在非高峰时段（清晨）重试
- 选择 shape 时使用"Always Free"过滤器

### Tailscale 无法连接

```bash
# 检查状态
sudo tailscale status

# 重新认证
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Gateway 网关无法启动

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### 无法访问控制 UI

```bash
# 验证 Tailscale Serve 正在运行
tailscale serve status

# 检查 Gateway 网关是否在监听
curl http://localhost:18789

# 如需要则重启
systemctl --user restart openclaw-gateway
```

### ARM 二进制文件问题

某些工具可能没有 ARM 构建。检查：

```bash
uname -m  # 应该显示 aarch64
```

大多数 npm 包工作正常。对于二进制文件，寻找 `linux-arm64` 或 `aarch64` 版本。

---

## 持久化

所有状态存储在：

- `~/.openclaw/` — 配置、凭证、会话数据
- `~/.openclaw/workspace/` — 工作区（SOUL.md、记忆、产物）

定期备份：

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## 另请参阅

- [Gateway 网关远程访问](/gateway/remote) — 其他远程访问模式
- [Tailscale 集成](/gateway/tailscale) — 完整的 Tailscale 文档
- [Gateway 网关配置](/gateway/configuration) — 所有配置选项
- [DigitalOcean 指南](/platforms/digitalocean) — 如果你想要付费 + 更容易注册
- [Hetzner 指南](/install/hetzner) — 基于 Docker 的替代方案
