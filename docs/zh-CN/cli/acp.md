---
read_when:
  - 设置基于 ACP 的 IDE 集成
  - 调试到 Gateway 网关的 ACP 会话路由
summary: 运行用于 IDE 集成的 ACP 桥接器
title: acp
x-i18n:
  generated_at: "2026-02-03T07:44:38Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 0c09844297da250bc1a558423e7e534d6b6be9045de12d797c07ecd64a0c63ed
  source_path: cli/acp.md
  workflow: 15
---

# acp

运行与 OpenClaw Gateway 网关通信的 ACP（Agent Client Protocol）桥接器。

此命令通过 stdio 使用 ACP 协议与 IDE 通信，并通过 WebSocket 将提示转发到 Gateway 网关。它将 ACP 会话映射到 Gateway 网关会话键。

## 用法

```bash
openclaw acp

# Remote Gateway
openclaw acp --url wss://gateway-host:18789 --token <token>

# Attach to an existing session key
openclaw acp --session agent:main:main

# Attach by label (must already exist)
openclaw acp --session-label "support inbox"

# Reset the session key before the first prompt
openclaw acp --session agent:main:main --reset-session
```

## ACP 客户端（调试）

使用内置 ACP 客户端在没有 IDE 的情况下检查桥接器的安装完整性。
它会启动 ACP 桥接器并让你交互式输入提示。

```bash
openclaw acp client

# Point the spawned bridge at a remote Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Override the server command (default: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## 如何使用

当 IDE（或其他客户端）使用 Agent Client Protocol 并且你希望它驱动 OpenClaw Gateway 网关会话时，请使用 ACP。

1. 确保 Gateway 网关正在运行（本地或远程）。
2. 配置 Gateway 网关目标（配置或标志）。
3. 将你的 IDE 配置为通过 stdio 运行 `openclaw acp`。

示例配置（持久化）：

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

示例直接运行（不写入配置）：

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## 选择智能体

ACP 不直接选择智能体。它通过 Gateway 网关会话键进行路由。

使用智能体作用域的会话键来定位特定智能体：

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

每个 ACP 会话映射到单个 Gateway 网关会话键。一个智能体可以有多个会话；除非你覆盖键或标签，否则 ACP 默认使用隔离的 `acp:<uuid>` 会话。

## Zed 编辑器设置

在 `~/.config/zed/settings.json` 中添加自定义 ACP 智能体（或使用 Zed 的设置界面）：

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

要定位特定的 Gateway 网关或智能体：

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": [
        "acp",
        "--url",
        "wss://gateway-host:18789",
        "--token",
        "<token>",
        "--session",
        "agent:design:main"
      ],
      "env": {}
    }
  }
}
```

在 Zed 中，打开 Agent 面板并选择"OpenClaw ACP"来开始一个会话。

## 会话映射

默认情况下，ACP 会话获得一个带有 `acp:` 前缀的隔离 Gateway 网关会话键。
要重用已知会话，请传递会话键或标签：

- `--session <key>`：使用特定的 Gateway 网关会话键。
- `--session-label <label>`：通过标签解析现有会话。
- `--reset-session`：为该键生成新的会话 ID（相同键，新对话记录）。

如果你的 ACP 客户端支持元数据，你可以按会话覆盖：

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

在 [/concepts/session](/concepts/session) 了解更多关于会话键的信息。

## 选项

- `--url <url>`：Gateway 网关 WebSocket URL（配置后默认为 gateway.remote.url）。
- `--token <token>`：Gateway 网关认证令牌。
- `--password <password>`：Gateway 网关认证密码。
- `--session <key>`：默认会话键。
- `--session-label <label>`：要解析的默认会话标签。
- `--require-existing`：如果会话键/标签不存在则失败。
- `--reset-session`：在首次使用前重置会话键。
- `--no-prefix-cwd`：不在提示前添加工作目录前缀。
- `--verbose, -v`：向 stderr 输出详细日志。

### `acp client` 选项

- `--cwd <dir>`：ACP 会话的工作目录。
- `--server <command>`：ACP 服务器命令（默认：`openclaw`）。
- `--server-args <args...>`：传递给 ACP 服务器的额外参数。
- `--server-verbose`：启用 ACP 服务器的详细日志。
- `--verbose, -v`：详细客户端日志。
