---
read_when:
  - 在 Oracle Cloud 上部署 OpenClaw
  - 寻找低成本 VPS 托管方案来运行 OpenClaw
  - 希望在小型服务器上全天候运行 OpenClaw
summary: 在 Oracle Cloud（Always Free ARM）上运行 OpenClaw
title: Oracle Cloud
x-i18n:
  generated_at: "2026-02-01T21:34:35Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: d3cc337b40ea512b5756ac15ec4341fecad417ede75f717fea3035678c7c6697
  source_path: platforms/oracle.md
  workflow: 15
---

# 在 Oracle Cloud (OCI) 上运行 OpenClaw

## 目标

在 Oracle Cloud 的 **Always Free** ARM 层级上运行持久化的 OpenClaw Gateway网关。

Oracle 的免费层级非常适合运行 OpenClaw（特别是如果你已有 OCI 账户），但也存在一些权衡：

- ARM 架构（大多数东西都能运行，但某些二进制文件可能仅支持 x86）
- 容量和注册流程可能不太稳定

## 费用对比（2026）

| 提供商       | 方案            | 配置                  | 月费用 | 备注               |
| ------------ | --------------- | --------------------- | ------ | ------------------ |
| Oracle Cloud | Always Free ARM | 最高 4 OCPU, 24GB RAM | $0     | ARM，容量有限      |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM       | ~ $4   | 最便宜的付费选项   |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM       | $6     | 界面简洁，文档完善 |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM       | $6     | 机房节点多         |
| Linode       | Nanode          | 1 vCPU, 1GB RAM       | $5     | 现为 Akamai 旗下   |

---

## 前提条件

- Oracle Cloud 账户（[注册](https://www.oracle.com/cloud/free/)）— 如果遇到问题请参阅[社区注册指南](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)
- Tailscale 账户（在 [tailscale.com](https://tailscale.com) 免费注册）
- 约 30 分钟

## 1) 创建 OCI 实例

1. 登录 [Oracle Cloud 控制台](https://cloud.oracle.com/)
2. 导航至 **Compute → Instances → Create Instance**
3. 配置：
   - **Name:** `openclaw`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2（最高 4）
   - **Memory:** 12 GB（最高 24 GB）
   - **Boot volume:** 50 GB（免费额度最高 200 GB）
   - **SSH key:** 添加你的公钥
4. 点击 **Create**
5. 记下公共 IP 地址

**提示：** 如果实例创建失败并提示 "Out of capacity"，请尝试其他可用性域或稍后重试。免费层级容量有限。

## 2) 连接并更新

```bash
# 通过公共 IP 连接
ssh ubuntu@YOUR_PUBLIC_IP

# 更新系统
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**注意：** ARM 架构下编译某些依赖需要 `build-essential`。

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

这将启用 Tailscale SSH，让你可以从 tailnet 上的任何设备通过 `ssh openclaw` 连接，无需公共 IP。

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

当提示 "How do you want to hatch your bot?" 时，选择 **"Do this later"**。

> 注意：如果遇到 ARM 原生构建问题，请先安装系统包（例如 `sudo apt install -y build-essential`），再考虑使用 Homebrew。

## 6) 配置 Gateway网关（local loopback 绑定 + 令牌认证）并启用 Tailscale Serve

默认使用令牌认证。这种方式可预测，且无需在控制 UI 中设置任何"不安全认证"标志。

```bash
# 将 Gateway网关限制在虚拟机本地
openclaw config set gateway.bind loopback

# 为 Gateway网关 + 控制 UI 启用认证
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

## 8) 锁定 VCN 安全规则

一切正常运行后，锁定 VCN 以阻止除 Tailscale 外的所有流量。OCI 的虚拟云网络在网络边缘充当防火墙——流量在到达实例之前就被拦截。

1. 在 OCI 控制台中进入 **Networking → Virtual Cloud Networks**
2. 点击你的 VCN → **Security Lists** → Default Security List
3. **删除**所有入站规则，仅保留：
   - `0.0.0.0/0 UDP 41641`（Tailscale）
4. 保留默认出站规则（允许所有出站流量）

这将在网络边缘阻止 22 端口 SSH、HTTP、HTTPS 及其他所有流量。从此以后，你只能通过 Tailscale 连接。

---

## 访问控制 UI

从 Tailscale 网络上的任意设备访问：

```
https://openclaw.<tailnet-name>.ts.net/
```

将 `<tailnet-name>` 替换为你的 tailnet 名称（可在 `tailscale status` 中查看）。

无需 SSH 隧道。Tailscale 提供：

- HTTPS 加密（自动证书）
- 通过 Tailscale 身份进行认证
- 从 tailnet 上的任何设备访问（笔记本电脑、手机等）

---

## 安全性：VCN + Tailscale（推荐基线）

锁定 VCN（仅开放 UDP 41641）并将 Gateway网关绑定到 local loopback 后，你将获得强大的纵深防御：公共流量在网络边缘被阻止，管理访问通过 tailnet 进行。

这种配置通常不再*需要*额外的主机防火墙规则来阻止全网 SSH 暴力破解——但你仍应保持操作系统更新、运行 `openclaw security audit`，并确认没有意外监听公共接口。

### 已受保护的内容

| 传统步骤        | 是否需要？ | 原因                                               |
| --------------- | ---------- | -------------------------------------------------- |
| UFW 防火墙      | 否         | VCN 在流量到达实例之前就已拦截                     |
| fail2ban        | 否         | VCN 阻止了 22 端口，不存在暴力破解                 |
| sshd 加固       | 否         | Tailscale SSH 不使用 sshd                          |
| 禁用 root 登录  | 否         | Tailscale 使用 Tailscale 身份认证，而非系统用户    |
| 仅密钥 SSH 认证 | 否         | Tailscale 通过 tailnet 进行认证                    |
| IPv6 加固       | 通常不需要 | 取决于你的 VCN/子网设置；请验证实际分配/暴露的内容 |

### 仍然建议执行

- **凭据权限：** `chmod 700 ~/.openclaw`
- **安全审计：** `openclaw security audit`
- **系统更新：** 定期运行 `sudo apt update && sudo apt upgrade`
- **监控 Tailscale：** 在 [Tailscale 管理控制台](https://login.tailscale.com/admin) 中检查设备

### 验证安全状态

```bash
# 确认没有公共端口在监听
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# 验证 Tailscale SSH 是否激活
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# 可选：完全禁用 sshd
sudo systemctl disable --now ssh
```

---

## 备选方案：SSH 隧道

如果 Tailscale Serve 无法正常工作，可使用 SSH 隧道：

```bash
# 从本地机器（通过 Tailscale）
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

然后打开 `http://localhost:18789`。

---

## 故障排除

### 实例创建失败（"Out of capacity"）

免费层级 ARM 实例非常热门。请尝试：

- 切换不同的可用性域
- 在非高峰时段重试（清晨）
- 选择配置时使用 "Always Free" 筛选器

### Tailscale 无法连接

```bash
# 检查状态
sudo tailscale status

# 重新认证
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Gateway网关无法启动

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### 无法访问控制 UI

```bash
# 验证 Tailscale Serve 是否在运行
tailscale serve status

# 检查 Gateway网关是否在监听
curl http://localhost:18789

# 需要时重启
systemctl --user restart openclaw-gateway
```

### ARM 二进制文件问题

某些工具可能没有 ARM 构建版本。检查：

```bash
uname -m  # 应显示 aarch64
```

大多数 npm 包都能正常工作。对于二进制文件，请查找 `linux-arm64` 或 `aarch64` 版本。

---

## 持久化

所有状态保存在：

- `~/.openclaw/` — 配置、凭据、会话数据
- `~/.openclaw/workspace/` — 工作区（SOUL.md、记忆、产物）

定期备份：

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## 另请参阅

- [Gateway网关远程访问](/gateway/remote) — 其他远程访问模式
- [Tailscale 集成](/gateway/tailscale) — 完整 Tailscale 文档
- [Gateway网关配置](/gateway/configuration) — 所有配置选项
- [DigitalOcean 指南](/platforms/digitalocean) — 付费但注册更简单的选择
- [Hetzner 指南](/platforms/hetzner) — 基于 Docker 的替代方案
