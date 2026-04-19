---
summary: "在 Linux 服务器或云 VPS 上运行 OpenClaw — 提供商选择器、架构和调优"
read_when:
  - 您想在 Linux 服务器或云 VPS 上运行网关
  - 您需要托管指南的快速地图
  - 您想要适用于所有地方的通用 Linux 调优
title: "Linux 服务器"
sidebarTitle: "Linux 服务器"
---

# Linux 服务器

在任何 Linux 服务器或云 VPS 上运行 OpenClaw 网关。本页帮助您选择提供商，解释云部署如何工作，并涵盖适用于所有地方的通用 Linux 调优。

## 选择提供商

<CardGroup cols={2}>
  <Card title="Railway" href="/install/railway">一键式，浏览器设置</Card>
  <Card title="Northflank" href="/install/northflank">一键式，浏览器设置</Card>
  <Card title="DigitalOcean" href="/install/digitalocean">简单付费 VPS</Card>
  <Card title="Oracle Cloud" href="/install/oracle">始终免费 ARM 层</Card>
  <Card title="Fly.io" href="/install/fly">Fly 机器</Card>
  <Card title="Hetzner" href="/install/hetzner">Hetzner VPS 上的 Docker</Card>
  <Card title="Hostinger" href="/install/hostinger">带一键式设置的 VPS</Card>
  <Card title="GCP" href="/install/gcp">计算引擎</Card>
  <Card title="Azure" href="/install/azure">Linux 虚拟机</Card>
  <Card title="exe.dev" href="/install/exe-dev">带 HTTPS 代理的 VM</Card>
  <Card title="Raspberry Pi" href="/install/raspberry-pi">ARM 自托管</Card>
</CardGroup>

**AWS (EC2 / Lightsail / free tier)** 也能很好地工作。
可在 [x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547) 获取社区视频演练（社区资源 — 可能会变得不可用）。

## 云设置如何工作

- **网关在 VPS 上运行**并拥有状态 + 工作区。
- 您通过**控制 UI** 或 **Tailscale/SSH** 从笔记本电脑或手机连接。
- 将 VPS 视为真实来源，并**定期备份**状态 + 工作区。
- 安全默认值：将网关保持在环回上，并通过 SSH 隧道或 Tailscale Serve 访问它。如果您绑定到 `lan` 或 `tailnet`，则需要 `gateway.auth.token` 或 `gateway.auth.password`。

相关页面：[网关远程访问](/gateway/remote)、[平台中心](/platforms)。

## VPS 上的共享公司代理

当每个用户都在同一信任边界内且代理仅用于业务时，为团队运行单个代理是一个有效的设置。

- 将其放在专用运行时上（VPS/VM/容器 + 专用操作系统用户/帐户）。
- 不要将该运行时登录到个人 Apple/Google 帐户或个人浏览器/密码管理器配置文件。
- 如果用户相互对抗，请按网关/主机/操作系统用户拆分。

安全模型详细信息：[安全](/gateway/security)。

## 将节点与 VPS 一起使用

您可以将网关保留在云中，并在本地设备（Mac/iOS/Android/无头）上配对**节点**。节点提供本地屏幕/相机/画布和 `system.run` 功能，同时网关保留在云中。

文档：[节点](/nodes)、[节点 CLI](/cli/nodes)。

## 小型 VM 和 ARM 主机的启动调优

如果 CLI 命令在低功耗 VM（或 ARM 主机）上感觉很慢，请启用 Node 的模块编译缓存：

```bash
grep -q 'NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache' ~/.bashrc || cat >> ~/.bashrc <<'EOF'
export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
mkdir -p /var/tmp/openclaw-compile-cache
export OPENCLAW_NO_RESPAWN=1
EOF
source ~/.bashrc
```

- `NODE_COMPILE_CACHE` 改进了重复命令的启动时间。
- `OPENCLAW_NO_RESPAWN=1` 避免了自重生路径的额外启动开销。
- 第一次命令运行会预热缓存；后续运行更快。
- 有关 Raspberry Pi 的具体信息，请参阅 [Raspberry Pi](/install/raspberry-pi)。

### systemd 调优清单（可选）

对于使用 `systemd` 的 VM 主机，请考虑：

- 为稳定的启动路径添加服务环境：
  - `OPENCLAW_NO_RESPAWN=1`
  - `NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache`
- 保持重启行为显式：
  - `Restart=always`
  - `RestartSec=2`
  - `TimeoutStartSec=90`
- 对于状态/缓存路径，首选 SSD 支持的磁盘，以减少随机 I/O 冷启动惩罚。

对于标准的 `openclaw onboard --install-daemon` 路径，请编辑用户单元：

```bash
systemctl --user edit openclaw-gateway.service
```

```ini
[Service]
Environment=OPENCLAW_NO_RESPAWN=1
Environment=NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
Restart=always
RestartSec=2
TimeoutStartSec=90
```

如果您故意安装了系统单元，请通过 `sudo systemctl edit openclaw-gateway.service` 编辑 `openclaw-gateway.service`。

`Restart=` 策略如何帮助自动恢复：[systemd 可以自动化服务恢复](https://www.redhat.com/en/blog/systemd-automate-recovery)。
