---
read_when:
  - 设置基于 ACP 的 IDE 集成
  - 调试 ACP 会话到 Gateway网关的路由
summary: 运行用于 IDE 集成的 ACP 桥接
title: acp
x-i18n:
  generated_at: "2026-02-01T19:58:33Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 0c09844297da250bc1a558423e7e534d6b6be9045de12d797c07ecd64a0c63ed
  source_path: cli/acp.md
  workflow: 14
---

# acp

运行与 OpenClaw Gateway网关通信的 ACP（Agent Client Protocol）桥接。

此命令通过 stdio 使用 ACP 协议与 IDE 通信，并通过 WebSocket 将提示转发到 Gateway网关。它将 ACP 会话映射到 Gateway网关会话密钥。

## 用法

```bash
openclaw acp

# 远程 Gateway网关
openclaw acp --url wss://gateway-host:18789 --token <token>

# 附加到现有会话密钥
openclaw acp --session agent:main:main

# 通过标签附加（必须已存在）
openclaw acp --session-label "support inbox"

# 在第一个提示之前重置会话密钥
openclaw acp --session agent:main:main --reset-session
```

## ACP 客户端（调试）

使用内置 ACP 客户端在无需 IDE 的情况下对桥接进行安装完整性检查。
它会启动 ACP 桥接并允许你交互式地输入提示。

```bash
openclaw acp client

# 将启动的桥接指向远程 Gateway网关
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# 覆盖服务器命令（默认：openclaw）
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## 如何使用

当 IDE（或其他客户端）使用 Agent Client Protocol 并且你希望它驱动 OpenClaw Gateway网关会话时，请使用 ACP。

1. 确保 Gateway网关正在运行（本地或远程）。
2. 配置 Gateway网关目标（通过配置文件或标志）。
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

ACP 不直接选择智能体。它通过 Gateway网关会话密钥进行路由。

使用智能体作用域的会话密钥来指定特定智能体：

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

每个 ACP 会话映射到单个 Gateway网关会话密钥。一个智能体可以有多个会话；除非你覆盖密钥或标签，否则 ACP 默认使用隔离的 `acp:<uuid>` 会话。

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

要指定特定的 Gateway网关或智能体：

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

在 Zed 中，打开 Agent 面板并选择 "OpenClaw ACP" 来开始一个对话线程。

## 会话映射

默认情况下，ACP 会话会获得一个带有 `acp:` 前缀的隔离 Gateway网关会话密钥。
要复用已知会话，请传递会话密钥或标签：

- `--session <key>`：使用特定的 Gateway网关会话密钥。
- `--session-label <label>`：通过标签解析现有会话。
- `--reset-session`：为该密钥生成新的会话 ID（相同密钥，新的对话记录）。

如果你的 ACP 客户端支持元数据，你可以按会话进行覆盖：

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

了解更多关于会话密钥的信息，请参阅 [/concepts/session](/concepts/session)。

## 选项

- `--url <url>`：Gateway网关 WebSocket URL（配置后默认使用 gateway.remote.url）。
- `--token <token>`：Gateway网关认证令牌。
- `--password <password>`：Gateway网关认证密码。
- `--session <key>`：默认会话密钥。
- `--session-label <label>`：要解析的默认会话标签。
- `--require-existing`：如果会话密钥/标签不存在则失败。
- `--reset-session`：在首次使用前重置会话密钥。
- `--no-prefix-cwd`：不在提示前添加工作目录前缀。
- `--verbose, -v`：将详细日志输出到 stderr。

### `acp client` 选项

- `--cwd <dir>`：ACP 会话的工作目录。
- `--server <command>`：ACP 服务器命令（默认：`openclaw`）。
- `--server-args <args...>`：传递给 ACP 服务器的额外参数。
- `--server-verbose`：启用 ACP 服务器的详细日志。
- `--verbose, -v`：详细客户端日志。
