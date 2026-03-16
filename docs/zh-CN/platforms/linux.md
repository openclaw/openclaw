---
read_when:
  - 查找 Linux 配套应用状态
  - 规划平台覆盖范围或贡献
summary: Linux 支持 + 配套应用状态
title: Linux 应用
x-i18n:
  generated_at: "2026-03-16T06:24:30Z"
  model: gpt-5.4
  provider: openai
  source_hash: 12f2a28ec8fc17769210bda97af11fda332355956d41bba69ac51cc523be6178
  source_path: platforms/linux.md
  workflow: 15
---

# Linux 应用

Gateway 网关在 Linux 上得到完全支持。**Node 是推荐的运行时**。
不建议将 Bun 用于 Gateway 网关（存在 WhatsApp/Telegram bug）。

原生 Linux 配套应用已在规划中。如果你想帮助构建一个，欢迎贡献。

## 面向初学者的快速路径（VPS）

1. 安装 Node 24（推荐；Node 22 LTS，目前 `22.16+`，为了兼容性仍然可用）
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. 在你的笔记本电脑上运行：`ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. 打开 `http://127.0.0.1:18789/` 并粘贴你的令牌

分步 VPS 指南：[exe.dev](/install/exe-dev)

## 安装

- [入门指南](/start/getting-started)
- [安装与更新](/install/updating)
- 可选流程：[Bun（实验性）](/install/bun)、[Nix](/install/nix)、[Docker](/install/docker)

## Gateway 网关

- [Gateway 网关运行手册](/gateway)
- [配置](/gateway/configuration)

## Gateway 网关服务安装（CLI）

使用以下任一方式：

```
openclaw onboard --install-daemon
```

或者：

```
openclaw gateway install
```

或者：

```
openclaw configure
```

出现提示时，选择 **Gateway 服务**。

修复/迁移：

```
openclaw doctor
```

## 系统控制（systemd 用户单元）

OpenClaw 默认安装 systemd **用户**服务。对于共享或始终在线的服务器，请使用 **系统** 服务。完整的单元示例和指导
请参见 [Gateway 网关运行手册](/gateway)。

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

[Install]
WantedBy=default.target
```

启用它：

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
