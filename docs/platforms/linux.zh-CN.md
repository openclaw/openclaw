---
summary: "Linux 支持 + 伴随应用状态"
read_when:
  - 查找 Linux 伴随应用状态
  - 规划平台覆盖或贡献
title: "Linux 应用"
---

# Linux 应用

网关在 Linux 上完全支持。**Node 是推荐的运行时**。
Bun 不推荐用于网关（WhatsApp/Telegram 错误）。

原生 Linux 伴随应用正在计划中。如果您想帮助构建一个，欢迎贡献。

## 初学者快速路径（VPS）

1. 安装 Node 24（推荐；Node 22 LTS，当前 `22.14+`，仍然兼容）
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. 从您的笔记本电脑：`ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. 打开 `http://127.0.0.1:18789/` 并使用配置的共享密钥进行身份验证（默认令牌；如果您设置了 `gateway.auth.mode: "password"` 则为密码）

完整的 Linux 服务器指南：[Linux 服务器](/vps)。分步 VPS 示例：[exe.dev](/install/exe-dev)

## 安装

- [快速开始](/start/getting-started)
- [安装和更新](/install/updating)
- 可选流程：[Bun（实验性）](/install/bun)、[Nix](/install/nix)、[Docker](/install/docker)

## 网关

- [网关运行手册](/gateway)
- [配置](/gateway/configuration)

## 网关服务安装（CLI）

使用以下方法之一：

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

当提示时选择 **Gateway service**。

修复/迁移：

```
openclaw doctor
```

## 系统控制（systemd 用户单元）

OpenClaw 默认安装 systemd **用户**服务。对于共享或始终开启的服务器，使用 **系统**服务。`openclaw gateway install` 和 `openclaw onboard --install-daemon` 已经为您渲染了当前的规范单元；仅在需要自定义系统/服务管理器设置时才手动编写。完整的服务指南位于 [网关运行手册](/gateway)。

最小设置：

创建 `~/.config/systemd/user/openclaw-gateway[-<profile>].service`：

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
TimeoutStopSec=30
TimeoutStartSec=30
SuccessExitStatus=0 143
KillMode=control-group

[Install]
WantedBy=default.target
```

启用它：

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
