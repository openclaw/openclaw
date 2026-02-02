---
read_when: 通过 SSH 将 macOS 应用连接到远程 Gateway网关
summary: 为 OpenClaw.app 连接远程 Gateway网关设置 SSH 隧道
title: 远程 Gateway网关设置
x-i18n:
  generated_at: "2026-02-01T20:35:41Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b1ae266a7cb4911b82ae3ec6cb98b1b57aca592aeb1dc8b74bbce9b0ea9dd1d1
  source_path: gateway/remote-gateway-readme.md
  workflow: 14
---

# 使用远程 Gateway网关运行 OpenClaw.app

OpenClaw.app 使用 SSH 隧道连接到远程 Gateway网关。本指南将介绍如何进行设置。

## 概述

```
┌─────────────────────────────────────────────────────────────┐
│                        客户端机器                              │
│                                                              │
│  OpenClaw.app ──► ws://127.0.0.1:18789（本地端口）              │
│                     │                                        │
│                     ▼                                        │
│  SSH 隧道 ──────────────────────────────────────────────────│
│                     │                                        │
└─────────────────────┼──────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                         远程机器                               │
│                                                              │
│  Gateway网关 WebSocket ──► ws://127.0.0.1:18789 ──►              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## 快速设置

### 第 1 步：添加 SSH 配置

编辑 `~/.ssh/config` 并添加：

```ssh
Host remote-gateway
    HostName <REMOTE_IP>          # 例如 172.27.187.184
    User <REMOTE_USER>            # 例如 jefferson
    LocalForward 18789 127.0.0.1:18789
    IdentityFile ~/.ssh/id_rsa
```

将 `<REMOTE_IP>` 和 `<REMOTE_USER>` 替换为你的实际值。

### 第 2 步：复制 SSH 密钥

将你的公钥复制到远程机器（需输入一次密码）：

```bash
ssh-copy-id -i ~/.ssh/id_rsa <REMOTE_USER>@<REMOTE_IP>
```

### 第 3 步：设置 Gateway网关令牌

```bash
launchctl setenv OPENCLAW_GATEWAY_TOKEN "<your-token>"
```

### 第 4 步：启动 SSH 隧道

```bash
ssh -N remote-gateway &
```

### 第 5 步：重启 OpenClaw.app

```bash
# 退出 OpenClaw.app（⌘Q），然后重新打开：
open /path/to/OpenClaw.app
```

应用现在将通过 SSH 隧道连接到远程 Gateway网关。

---

## 登录时自动启动隧道

要在登录时自动启动 SSH 隧道，请创建一个 Launch Agent。

### 创建 PLIST 文件

将以下内容保存为 `~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>bot.molt.ssh-tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/ssh</string>
        <string>-N</string>
        <string>remote-gateway</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

### 加载 Launch Agent

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist
```

隧道现在将：

- 在你登录时自动启动
- 崩溃后自动重启
- 在后台持续运行

旧版说明：如果存在残留的 `com.openclaw.ssh-tunnel` LaunchAgent，请将其删除。

---

## 故障排除

**检查隧道是否正在运行：**

```bash
ps aux | grep "ssh -N remote-gateway" | grep -v grep
lsof -i :18789
```

**重启隧道：**

```bash
launchctl kickstart -k gui/$UID/bot.molt.ssh-tunnel
```

**停止隧道：**

```bash
launchctl bootout gui/$UID/bot.molt.ssh-tunnel
```

---

## 工作原理

| 组件                                 | 功能说明                                    |
| ------------------------------------ | ------------------------------------------- |
| `LocalForward 18789 127.0.0.1:18789` | 将本地端口 18789 转发到远程端口 18789       |
| `ssh -N`                             | 仅进行端口转发的 SSH 连接（不执行远程命令） |
| `KeepAlive`                          | 隧道崩溃时自动重启                          |
| `RunAtLoad`                          | 在代理加载时启动隧道                        |

OpenClaw.app 连接到客户端机器上的 `ws://127.0.0.1:18789`。SSH 隧道将该连接转发到运行 Gateway网关的远程机器的 18789 端口。
