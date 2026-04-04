---
read_when:
  - 你想在云端运行 Gateway 网关
  - 你需要 VPS/托管指南的快速索引
summary: OpenClaw 的 VPS 托管中心（Oracle/Fly/Hetzner/GCP/exe.dev）
title: VPS 托管
x-i18n:
  generated_at: "2026-03-11T01:10:00Z"
  model: claude-opus-4-6
  provider: pi
  source_hash: c25ec2492890da400d6011e0d25664ef0103af6c448c1ceb7a3fa33764895c20
  source_path: vps.md
  workflow: 15
---

# VPS 托管

本中心链接到支持的 VPS/托管指南，并在高层次上解释云部署的工作原理。

## 选择提供商

- **Railway**（一键 + 浏览器设置）：[Railway](/install/railway)
- **Northflank**（一键 + 浏览器设置）：[Northflank](/install/northflank)
- **Oracle Cloud（永久免费）**：[Oracle](/platforms/oracle) — $0/月（永久免费，ARM；容量/注册可能不太稳定）
- **Fly.io**：[Fly.io](/install/fly)
- **Hetzner（Docker）**：[Hetzner](/install/hetzner)
- **GCP（Compute Engine）**：[GCP](/install/gcp)
- **exe.dev**（VM + HTTPS 代理）：[exe.dev](/install/exe-dev)
- **AWS（EC2/Lightsail/免费套餐）**：也运行良好。视频指南：
  https://x.com/techfrenAJ/status/2014934471095812547

## 云设置的工作原理

- **Gateway 网关运行在 VPS 上**并拥有状态 + 工作区。
- 你通过**控制 UI** 或 **Tailscale/SSH** 从笔记本电脑/手机连接。
- 将 VPS 视为数据源并**备份**状态 + 工作区。
- 安全默认：将 Gateway 网关保持在 loopback 上，通过 SSH 隧道或 Tailscale Serve 访问。
  如果你绑定到 `lan`/`tailnet`，需要 `gateway.auth.token` 或 `gateway.auth.password`。

远程访问：[Gateway 网关远程访问](/gateway/remote)
平台中心：[平台](/platforms)

## 在 VPS 上使用节点

你可以将 Gateway 网关保持在云端，并在本地设备（Mac/iOS/Android/无头）上配对**节点**。节点提供本地屏幕/摄像头/canvas 和 `system.run` 功能，而 Gateway 网关保持在云端。

文档：[节点](/nodes)，[节点 CLI](/cli/nodes)

## 小型 VM 和 ARM 主机的启动调优

如果在低功耗 VM（或 ARM 主机）上 CLI 命令感觉缓慢，可以启用 Node 的模块编译缓存：

```bash
grep -q 'NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache' ~/.bashrc || cat >> ~/.bashrc <<'EOF'
export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
mkdir -p /var/tmp/openclaw-compile-cache
export OPENCLAW_NO_RESPAWN=1
EOF
source ~/.bashrc
```

- `NODE_COMPILE_CACHE` 改善重复命令的启动时间。
- `OPENCLAW_NO_RESPAWN=1` 避免自重启路径带来的额外启动开销。
- 首次运行会预热缓存；后续运行会更快。
- Raspberry Pi 特定配置参见 [Raspberry Pi](/platforms/raspberry-pi)。

### systemd 调优清单（可选）

对于使用 `systemd` 的 VM 主机，建议：

- 添加服务环境变量以获得稳定的启动路径：
  - `OPENCLAW_NO_RESPAWN=1`
  - `NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache`
- 保持明确的重启行为：
  - `Restart=always`
  - `RestartSec=2`
  - `TimeoutStartSec=90`
- 优先使用 SSD 支持的磁盘存放状态/缓存路径，以减少随机 I/O 冷启动延迟。

示例：

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

`Restart=` 策略如何帮助自动恢复：
[systemd 可以自动化服务恢复](https://www.redhat.com/en/blog/systemd-automate-recovery)。

## 企业代理和 SSL 检查

如果你的 VPS 运行在带有 SSL 检查的企业代理后面（在企业网络中很常见），
你需要在 systemd 服务文件中显式配置环境变量。

### 关键问题

1. **systemd 服务不会读取 `/etc/environment`** — 环境变量必须通过 `Environment=` 指令
   在服务文件中显式设置。

2. **代理环境变量大小写敏感** — 部分 Node.js 库（如 `undici`）只检查大写的
   `HTTP_PROXY`/`HTTPS_PROXY`，而其他库检查小写变体。**最佳实践：同时设置两者。**

3. **SSL 证书信任** — 企业代理通常执行 SSL 检查（中间人），这会导致 Node.js
   拒绝连接并报 `SELF_SIGNED_CERT_IN_CHAIN` 错误。你必须将 Node.js 指向企业 CA 证书。

### 配置示例

编辑 systemd 服务覆盖：

```bash
sudo systemctl edit openclaw
```

添加以下环境变量：

```ini
[Service]
# 代理配置（同时设置大写和小写）
Environment=HTTP_PROXY=http://proxy.example.com:3127
Environment=HTTPS_PROXY=http://proxy.example.com:3127
Environment=http_proxy=http://proxy.example.com:3127
Environment=https_proxy=http://proxy.example.com:3127

# 企业 CA 证书（用于 SSL 检查）
Environment=NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem

# 可选：绕过内部主机的代理
Environment=no_proxy=127.0.0.1,localhost,.internal.example.com
Environment=NO_PROXY=127.0.0.1,localhost,.internal.example.com
```

编辑后，重新加载并重启：

```bash
sudo systemctl daemon-reload
sudo systemctl restart openclaw
```

### 故障排查

如果配置后 LLM 请求仍然失败：

1. **验证代理连通性**，使用 curl：

   ```bash
   curl -v --proxy http://proxy.example.com:3127 https://api.anthropic.com
   ```

2. **检查进程环境变量**（验证变量是否加载）：

   ```bash
   sudo cat /proc/$(pgrep -fn openclaw)/environ | tr '\0' '\n' | grep -i proxy
   ```

3. **检查 OpenClaw 日志中的代理/TLS 错误**（不需要额外 Node 包）：

   ```bash
   sudo journalctl -u openclaw -n 200 --no-pager | grep -Ei 'SELF_SIGNED_CERT_IN_CHAIN|CERT|ECONN|ETIMEDOUT|timeout|proxy'
   ```

   - 如果看到 `SELF_SIGNED_CERT_IN_CHAIN`，验证 `NODE_EXTRA_CA_CERTS` 指向正确的 CA 文件。
   - 如果看到超时/连接错误，验证代理 URL 和网络可达性。
