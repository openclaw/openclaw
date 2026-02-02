---
read_when:
  - 查找 Linux 伴侣应用状态
  - 规划平台覆盖范围或贡献
summary: Linux 支持 + 伴侣应用状态
title: Linux 应用
x-i18n:
  generated_at: "2026-02-01T21:32:18Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: a9bbbcecf2fd522a2f5ac8f3b9068febbc43658465bfb9276bff6c3e946789d2
  source_path: platforms/linux.md
  workflow: 15
---

# Linux 应用

Gateway网关在 Linux 上完全受支持。**推荐使用 Node 作为运行时**。
不建议将 Bun 用于 Gateway网关（WhatsApp/Telegram 存在 bug）。

原生 Linux 伴侣应用已在计划中。如果你想帮助构建，欢迎贡献。

## 新手快速路径（VPS）

1. 安装 Node 22+
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. 从你的笔记本电脑：`ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. 打开 `http://127.0.0.1:18789/` 并粘贴你的令牌

分步 VPS 指南：[exe.dev](/platforms/exe-dev)

## 安装

- [快速开始](/start/getting-started)
- [安装与更新](/install/updating)
- 可选流程：[Bun（实验性）](/install/bun)、[Nix](/install/nix)、[Docker](/install/docker)

## Gateway网关

- [Gateway网关运维手册](/gateway)
- [配置](/gateway/configuration)

## Gateway网关服务安装（CLI）

使用以下任一方式：

```
openclaw onboard --install-daemon
```

或：

```
openclaw gateway install
```

或：

```
openclaw configure
```

出现提示时选择 **Gateway网关服务**。

修复/迁移：

```
openclaw doctor
```

## 系统控制（systemd 用户单元）

OpenClaw 默认安装 systemd **用户**服务。对于共享或常驻服务器，请使用**系统**服务。完整的单元示例和指南请参阅 [Gateway网关运维手册](/gateway)。

最小化设置：

创建 `~/.config/systemd/user/openclaw-gateway[-<profile>].service`：

```
[Unit]
Description=OpenClaw Gateway网关 (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

启用服务：

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
