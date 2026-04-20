---
summary: "运行用于IDE集成的ACP桥接"
read_when:
  - 设置基于ACP的IDE集成
  - 调试ACP会话路由到Gateway
  - 了解ACP与OpenClaw的集成方式
title: "acp"
---

# acp

运行与OpenClaw Gateway通信的[Agent Client Protocol (ACP)](https://agentclientprotocol.com/)桥接。

此命令通过标准输入/输出与IDE进行ACP通信，并通过WebSocket将提示转发到Gateway。它保持ACP会话与Gateway会话密钥的映射。

`openclaw acp`是一个基于Gateway的ACP桥接，不是完整的ACP原生编辑器运行时。它专注于会话路由、提示传递和基本流更新。

如果您希望外部MCP客户端直接与OpenClaw频道对话，而不是托管ACP harness会话，请使用[`openclaw mcp serve`](/cli/mcp)。

## 这不是什么

本页面经常与ACP harness会话混淆。

`openclaw acp`意味着：

- OpenClaw作为ACP服务器
- IDE或ACP客户端连接到OpenClaw
- OpenClaw将工作转发到Gateway会话

这与[ACP Agents](/tools/acp-agents)不同，在ACP Agents中，OpenClaw通过`acpx`运行外部harness，如Codex或Claude Code。

快速规则：

- 编辑器/客户端想与OpenClaw进行ACP通信：使用`openclaw acp`
- OpenClaw应将Codex/Claude/Gemini作为ACP harness启动：使用`/acp spawn`和[ACP Agents](/tools/acp-agents)

## 兼容性矩阵

| ACP 区域                                                             | 状态        | 说明                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`, `newSession`, `prompt`, `cancel`                     | 已实现       | 通过标准输入/输出到Gateway chat/send + abort的核心桥接流程。                                                                                                                                                                                |
| `listSessions`, 斜杠命令                                              | 已实现       | 会话列表针对Gateway会话状态工作；命令通过`available_commands_update`发布。                                                                                                                                                                    |
| `loadSession`                                                      | 部分实现      | 将ACP会话重新绑定到Gateway会话密钥并重播存储的用户/助手文本历史。工具/系统历史尚未重建。                                                                                                                                                           |
| 提示内容（`text`、嵌入的`resource`、图像）                                   | 部分实现      | 文本/资源被扁平化为聊天输入；图像成为Gateway附件。                                                                                                                                                                                              |
| 会话模式                                                              | 部分实现      | 支持`session/set_mode`，桥接暴露初始的基于Gateway的会话控制，包括思考级别、工具详细程度、推理、使用详情和提升操作。更广泛的ACP原生模式/配置界面仍不在范围内。                                                                                                 |
| 会话信息和使用更新                                                         | 部分实现      | 桥接从缓存的Gateway会话快照发出`session_info_update`和尽力而为的`usage_update`通知。使用情况是近似的，仅在Gateway令牌总数标记为最新时发送。                                                                                                          |
| 工具流                                                               | 部分实现      | `tool_call` / `tool_call_update`事件包括原始I/O、文本内容和当Gateway工具参数/结果暴露时的尽力而为的文件位置。嵌入式终端和更丰富的差异原生输出尚未暴露。                                                                                                 |
| 每会话MCP服务器（`mcpServers`）                                            | 不支持       | 桥接模式拒绝每会话MCP服务器请求。在OpenClaw gateway或agent上配置MCP。                                                                                                                                                                         |
| 客户端文件系统方法（`fs/read_text_file`，`fs/write_text_file`）             | 不支持       | 桥接不调用ACP客户端文件系统方法。                                                                                                                                                                                                              |
| 客户端终端方法（`terminal/*`）                                          | 不支持       | 桥接不创建ACP客户端终端或通过工具调用流式传输终端ID。                                                                                                                                                                                            |
| 会话计划/思考流                                                          | 不支持       | 桥接当前发出输出文本和工具状态，而不是ACP计划或思考更新。                                                                                                                                                                                       |

## 已知限制

- `loadSession`重播存储的用户和助手文本历史，但它不会重建历史工具调用、系统通知或更丰富的ACP原生事件类型。
- 如果多个ACP客户端共享同一个Gateway会话密钥，事件和取消路由是尽力而为的，而不是严格隔离每个客户端。当您需要干净的编辑器本地回合时，首选默认的隔离`acp:<uuid>`会话。
- Gateway停止状态被转换为ACP停止原因，但该映射不如完全ACP原生运行时表达力强。
- 初始会话控制当前展示Gateway旋钮的一个集中子集：思考级别、工具详细程度、推理、使用详情和提升操作。模型选择和exec-host控制尚未作为ACP配置选项暴露。
- `session_info_update`和`usage_update`派生自Gateway会话快照，而不是实时ACP原生运行时计费。使用情况是近似的，不携带成本数据，仅在Gateway标记总令牌数据为最新时发出。
- 工具跟随数据是尽力而为的。桥接可以显示出现在已知工具参数/结果中的文件路径，但它尚未发出ACP终端或结构化文件差异。

## 用法

```bash
openclaw acp

# 远程Gateway
openclaw acp --url wss://gateway-host:18789 --token <token>

# 远程Gateway（令牌来自文件）
openclaw acp --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token

# 附加到现有会话密钥
openclaw acp --session agent:main:main

# 通过标签附加（必须已存在）
openclaw acp --session-label "support inbox"

# 在第一个提示之前重置会话密钥
openclaw acp --session agent:main:main --reset-session
```

## ACP客户端（调试）

使用内置的ACP客户端在没有IDE的情况下检查桥接。它生成ACP桥接并让您交互式地输入提示。

```bash
openclaw acp client

# 将生成的桥接指向远程Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token

# 覆盖服务器命令（默认：openclaw）
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

权限模型（客户端调试模式）：

- 自动批准基于允许列表，仅适用于受信任的核心工具ID。
- `read`自动批准范围限定在当前工作目录（设置`--cwd`时）。
- ACP仅自动批准狭窄的只读类：活动cwd下的范围`read`调用加上只读搜索工具（`search`、`web_search`、`memory_search`）。未知/非核心工具、范围外读取、可执行工具、控制平面工具、变异工具和交互式流始终需要显式提示批准。
- 服务器提供的`toolCall.kind`被视为不可信的元数据（不是授权源）。
- 此ACP桥接策略与ACPX harness权限分开。如果您通过`acpx`后端运行OpenClaw，`plugins.entries.acpx.config.permissionMode=approve-all`是该harness会话的打破玻璃"yolo"开关。

## 如何使用

当IDE（或其他客户端）使用Agent Client Protocol并且您希望它驱动OpenClaw Gateway会话时，使用ACP。

1. 确保Gateway正在运行（本地或远程）。
2. 配置Gateway目标（配置或标志）。
3. 指向您的IDE通过标准输入/输出运行`openclaw acp`。

示例配置（持久化）：

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

示例直接运行（无配置写入）：

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
# 首选本地进程安全
openclaw acp --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token
```

## 选择代理

ACP不直接选择代理。它通过Gateway会话密钥路由。

使用代理范围的会话密钥来针对特定代理：

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

每个ACP会话映射到单个Gateway会话密钥。一个代理可以有多个会话；除非您覆盖密钥或标签，否则ACP默认为隔离的`acp:<uuid>`会话。

桥接模式不支持每会话`mcpServers`。如果ACP客户端在`newSession`或`loadSession`期间发送它们，桥接会返回明确的错误，而不是静默忽略它们。

如果您希望ACPX支持的会话看到OpenClaw插件工具，请启用gateway端的ACPX插件桥接，而不是尝试传递每会话`mcpServers`。请参阅[ACP Agents](/tools/acp-agents#plugin-tools-mcp-bridge)。

## 从`acpx`使用（Codex、Claude等ACP客户端）

如果您希望编码代理（如Codex或Claude Code）通过ACP与您的OpenClaw机器人对话，请使用带有内置`openclaw`目标的`acpx`。

典型流程：

1. 运行Gateway并确保ACP桥接可以到达它。
2. 将`acpx openclaw`指向`openclaw acp`。
3. 目标OpenClaw会话密钥，您希望编码代理使用。

示例：

```bash
# 一次性请求到默认的OpenClaw ACP会话
acpx openclaw exec "Summarize the active OpenClaw session state."

# 用于后续回合的持久命名会话
acpx openclaw sessions ensure --name codex-bridge
acpx openclaw -s codex-bridge --cwd /path/to/repo \
  "Ask my OpenClaw work agent for recent context relevant to this repo."
```

如果您希望`acpx openclaw`每次都针对特定的Gateway和会话密钥，请在`~/.acpx/config.json`中覆盖`openclaw`代理命令：

```json
{
  "agents": {
    "openclaw": {
      "command": "env OPENCLAW_HIDE_BANNER=1 OPENCLAW_SUPPRESS_NOTES=1 openclaw acp --url ws://127.0.0.1:18789 --token-file ~/.openclaw/gateway.token --session agent:main:main"
    }
  }
}
```

对于repo本地的OpenClaw checkout，使用直接的CLI入口点而不是开发运行器，以便ACP流保持干净。例如：

```bash
env OPENCLAW_HIDE_BANNER=1 OPENCLAW_SUPPRESS_NOTES=1 node openclaw.mjs acp ...
```

这是让Codex、Claude Code或其他ACP感知客户端从OpenClaw代理中提取上下文信息而不抓取终端的最简单方法。

## Zed编辑器设置

在`~/.config/zed/settings.json`中添加自定义ACP代理（或使用Zed的设置UI）：

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

要针对特定的Gateway或代理：

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

在Zed中，打开Agent面板并选择"OpenClaw ACP"开始一个线程。

## 会话映射

默认情况下，ACP会话获得带有`acp:`前缀的隔离Gateway会话密钥。要重用已知会话，请传递会话密钥或标签：

- `--session <key>`: 使用特定的Gateway会话密钥。
- `--session-label <label>`: 通过标签解析现有会话。
- `--reset-session`: 为该密钥创建新的会话ID（相同的密钥，新的记录）。

如果您的ACP客户端支持元数据，您可以按会话覆盖：

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

在[/concepts/session](/concepts/session)了解更多关于会话密钥的信息。

## 选项

- `--url <url>`: Gateway WebSocket URL（默认在配置时默认为gateway.remote.url）。
- `--token <token>`: Gateway认证令牌。
- `--token-file <path>`: 从文件读取Gateway认证令牌。
- `--password <password>`: Gateway认证密码。
- `--password-file <path>`: 从文件读取Gateway认证密码。
- `--session <key>`: 默认会话密钥。
- `--session-label <label>`: 要解析的默认会话标签。
- `--require-existing`: 如果会话密钥/标签不存在则失败。
- `--reset-session`: 在首次使用前重置会话密钥。
- `--no-prefix-cwd`: 不要用工作目录前缀提示。
- `--provenance <off|meta|meta+receipt>`: 包含ACP来源元数据或收据。
- `--verbose, -v`: 向stderr输出详细日志。

安全注意事项：

- `--token`和`--password`在某些系统上可能在本地进程列表中可见。
- 首选`--token-file`/`--password-file`或环境变量（`OPENCLAW_GATEWAY_TOKEN`，`OPENCLAW_GATEWAY_PASSWORD`）。
- Gateway认证解析遵循其他Gateway客户端使用的共享契约：
  - 本地模式：env（`OPENCLAW_GATEWAY_*`）-> `gateway.auth.*` -> 仅当`gateway.auth.*`未设置时的`gateway.remote.*`回退（已配置但未解析的本地SecretRefs失败关闭）
  - 远程模式：`gateway.remote.*`，带有按远程优先级规则的env/config回退
  - `--url`是覆盖安全的，不重用隐式config/env凭据；传递显式`--token`/`--password`（或文件变体）
- ACP运行时后端子进程接收`OPENCLAW_SHELL=acp`，可用于上下文特定的shell/profile规则。
- `openclaw acp client`在生成的桥接进程上设置`OPENCLAW_SHELL=acp-client`。

### `acp client`选项

- `--cwd <dir>`: ACP会话的工作目录。
- `--server <command>`: ACP服务器命令（默认：`openclaw`）。
- `--server-args <args...>`: 传递给ACP服务器的额外参数。
- `--server-verbose`: 在ACP服务器上启用详细日志记录。
- `--verbose, -v`: 详细客户端日志。