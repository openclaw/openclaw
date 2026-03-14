---
read_when:
  - 你想要带安全加固的自动化服务器部署
  - 你需要带 VPN 访问的防火墙隔离设置
  - 你正在部署到远程 Debian/Ubuntu 服务器
summary: 使用 Ansible、Tailscale VPN 和防火墙隔离进行自动化、加固的 OpenClaw 安装
title: Ansible
x-i18n:
  generated_at: "2026-02-03T07:49:29Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 896807f344d923f09039f377c13b4bf4a824aa94eec35159fc169596a3493b29
  source_path: install/ansible.md
  workflow: 15
---

# Ansible 安装

将 OpenClaw 部署到生产服务器的推荐方式是通过 **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** — 一个安全优先架构的自动化安装程序。

## 快速开始

一条命令安装：

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 完整指南：[github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> openclaw-ansible 仓库是 Ansible 部署的权威来源。本页是快速概述。

## 你将获得

- 🔒 **防火墙优先安全**：UFW + Docker 隔离（仅 SSH + Tailscale 可访问）
- 🔐 **Tailscale VPN**：安全远程访问，无需公开暴露服务
- 🐳 **Docker**：隔离的沙箱容器，仅绑定 localhost
- 🛡️ **纵深防御**：4 层安全架构
- 🚀 **一条命令设置**：几分钟内完成部署
- 🔧 **Systemd 集成**：带加固的开机自启动

## 要求

- **操作系统**：Debian 11+ 或 Ubuntu 20.04+
- **访问权限**：Root 或 sudo 权限
- **网络**：用于包安装的互联网连接
- **Ansible**：2.14+（由快速启动脚本自动安装）

## 安装内容

Ansible playbook 安装并配置：

1. **Tailscale**（用于安全远程访问的 mesh VPN）
2. **UFW 防火墙**（仅允许 SSH + Tailscale 端口）
3. **Docker CE + Compose V2**（用于智能体沙箱）
4. **Node.js 22.x + pnpm**（运行时依赖）
5. **OpenClaw**（基于主机，非容器化）
6. **Systemd 服务**（带安全加固的自动启动）

注意：Gateway 网关**直接在主机上运行**（不在 Docker 中），但智能体沙箱使用 Docker 进行隔离。详情参见[沙箱隔离](/gateway/sandboxing)。

## 安装后设置

安装完成后，切换到 openclaw 用户：

```bash
sudo -i -u openclaw
```

安装后脚本将引导你完成：

1. **新手引导向导**：配置 OpenClaw 设置
2. **提供商登录**：连接 WhatsApp/Telegram/Discord/Signal
3. **Gateway 网关测试**：验证安装
4. **Tailscale 设置**：连接到你的 VPN mesh

### 常用命令

```bash
# 检查服务状态
sudo systemctl status openclaw

# 查看实时日志
sudo journalctl -u openclaw -f

# 重启 Gateway 网关
sudo systemctl restart openclaw

# 提供商登录（以 openclaw 用户运行）
sudo -i -u openclaw
openclaw channels login
```

## 安全架构

### 4 层防御

1. **防火墙（UFW）**：仅公开暴露 SSH（22）+ Tailscale（41641/udp）
2. **VPN（Tailscale）**：Gateway 网关仅通过 VPN mesh 可访问
3. **Docker 隔离**：DOCKER-USER iptables 链防止外部端口暴露
4. **Systemd 加固**：NoNewPrivileges、PrivateTmp、非特权用户

### 验证

测试外部攻击面：

```bash
nmap -p- YOUR_SERVER_IP
```

应该显示**仅端口 22**（SSH）开放。所有其他服务（Gateway 网关、Docker）都被锁定。

### Docker 可用性

Docker 用于**智能体沙箱**（隔离的工具执行），而不是用于运行 Gateway 网关本身。Gateway 网关仅绑定到 localhost，通过 Tailscale VPN 访问。

沙箱配置参见[多智能体沙箱与工具](/tools/multi-agent-sandbox-tools)。

## 手动安装

如果你更喜欢手动控制而非自动化：

```bash
# 1. 安装先决条件
sudo apt update && sudo apt install -y ansible git

# 2. 克隆仓库
git clone https://github.com/openclaw/openclaw-ansible.git
cd openclaw-ansible

# 3. 安装 Ansible collections
ansible-galaxy collection install -r requirements.yml

# 4. 运行 playbook
./run-playbook.sh

# 或直接运行（然后手动执行 /tmp/openclaw-setup.sh）
# ansible-playbook playbook.yml --ask-become-pass
```

## 更新 OpenClaw

Ansible 安装程序设置 OpenClaw 为手动更新。标准更新流程参见[更新](/install/updating)。

要重新运行 Ansible playbook（例如，用于配置更改）：

```bash
cd openclaw-ansible
./run-playbook.sh
```

注意：这是幂等的，可以安全地多次运行。

## 故障排除

### 防火墙阻止了我的连接

如果你被锁定：

- 确保你可以先通过 Tailscale VPN 访问
- SSH 访问（端口 22）始终允许
- Gateway 网关**仅**通过 Tailscale 访问，这是设计如此

### 服务无法启动

```bash
# 检查日志
sudo journalctl -u openclaw -n 100

# 验证权限
sudo ls -la /opt/openclaw

# 测试手动启动
sudo -i -u openclaw
cd ~/openclaw
pnpm start
```

### Docker 沙箱问题

```bash
# 验证 Docker 正在运行
sudo systemctl status docker

# 检查沙箱镜像
sudo docker images | grep openclaw-sandbox

# 如果缺失则构建沙箱镜像
cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh
```

### 提供商登录失败

确保你以 `openclaw` 用户运行：

```bash
sudo -i -u openclaw
openclaw channels login
```

## 高级配置

详细的安全架构和故障排除：

- [安全架构](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [技术详情](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [故障排除指南](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## 相关内容

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — 完整部署指南
- [Docker](/install/docker) — 容器化 Gateway 网关设置
- [沙箱隔离](/gateway/sandboxing) — 智能体沙箱配置
- [多智能体沙箱与工具](/tools/multi-agent-sandbox-tools) — 每个智能体的隔离
