---
summary: "通过 MCP 暴露 OpenClaw 频道对话并管理保存的 MCP 服务器定义"
read_when:
  - 将 Codex、Claude Code 或其他 MCP 客户端连接到 OpenClaw 支持的频道
  - 运行 `openclaw mcp serve`
  - 管理 OpenClaw 保存的 MCP 服务器定义
title: "mcp"
---

# mcp

`openclaw mcp` 有两个功能：

- 使用 `openclaw mcp serve` 将 OpenClaw 作为 MCP 服务器运行
- 使用 `list`、`show`、`set` 和 `unset` 管理 OpenClaw 拥有的出站 MCP 服务器定义

换句话说：

- `serve` 是 OpenClaw 作为 MCP 服务器
- `list` / `show` / `set` / `unset` 是 OpenClaw 作为 MCP 客户端注册表，供其运行时分阶段消费其他 MCP 服务器

当 OpenClaw 托管编码工具会话本身并通过 ACP 路由该运行时，请使用 [`openclaw acp`](/cli/acp)。

## OpenClaw 作为 MCP 服务器

这是 `openclaw mcp serve` 路径。

## 何时使用 `serve`

在以下情况下使用 `openclaw mcp serve`：

- Codex、Claude Code 或其他 MCP 客户端应直接与 OpenClaw 支持的频道对话
- 你已经有一个本地或远程 OpenClaw Gateway 并有路由会话
- 你需要一个跨 OpenClaw 频道后端工作的 MCP 服务器，而不是运行单独的每个频道桥接器

当 OpenClaw 托管编码运行时本身并将智能体会话保留在 OpenClaw 内部时，请改用 [`openclaw acp`](/cli/acp)。

## 工作原理

`openclaw mcp serve` 启动一个 stdio MCP 服务器。MCP 客户端拥有该进程。只要客户端保持 stdio 会话打开，桥接器就通过 WebSocket 连接到本地或远程 OpenClaw Gateway，并通过 MCP 暴露路由的频道对话。

生命周期：

1. MCP 客户端生成 `openclaw mcp serve`
2. 桥接器连接到 Gateway
3. 路由会话成为 MCP 对话和记录/历史工具
4. 实时事件在桥接器连接时在内存中排队
5. 如果 Claude 频道模式启用，相同会话也可以接收 Claude 特定的推送通知

重要行为：

- 实时队列状态在桥接器连接时开始
- 较早的记录历史使用 `messages_read` 读取
- Claude 推送通知仅在 MCP 会话存活时存在
- 当客户端断开连接时，桥接器退出，实时队列消失

## 选择客户端模式

以两种不同方式使用相同的桥接器：

- 通用 MCP 客户端：仅标准 MCP 工具。使用 `conversations_list`、`messages_read`、`events_poll`、`events_wait`、`messages_send` 和批准工具。
- Claude Code：标准 MCP 工具加上 Claude 特定的频道适配器。启用 `--claude-channel-mode on` 或保留默认的 `auto`。

目前，`auto` 的行为与 `on` 相同。尚无客户端功能检测。

## `serve` 暴露的内容

桥接器使用现有 Gateway 会话路由元数据来暴露频道支持的对话。当 OpenClaw 已有具有已知路由的会话状态时，对话就会出现，例如：

- `channel`
- 接收者或目标元数据
- 可选的 `accountId`
- 可选的 `threadId`

这为 MCP 客户端提供了一个地方来：

- 列出最近的路由对话
- 读取最近的记录历史
- 等待新的入站事件
- 通过相同路由发送回复
- 查看桥接器连接期间到达的批准请求

## 用法

```bash
# 本地 Gateway
openclaw mcp serve

# 远程 Gateway
openclaw mcp serve --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token

# 使用密码认证的远程 Gateway
openclaw mcp serve --url wss://gateway-host:18789 --password-file ~/.openclaw/gateway.password

# 启用详细桥接器日志
openclaw mcp serve --verbose

# 禁用 Claude 特定的推送通知
openclaw mcp serve --claude-channel-mode off
```

## 桥接器工具

当前桥接器暴露这些 MCP 工具：

- `conversations_list`
- `conversation_get`
- `messages_read`
- `attachments_fetch`
- `events_poll`
- `events_wait`
- `messages_send`
- `permissions_list_open`
- `permissions_respond`

### `conversations_list`

列出 Gateway 会话状态中已有路由元数据的最近会话支持对话。

有用的过滤器：

- `limit`
- `search`
- `channel`
- `includeDerivedTitles`
- `includeLastMessage`

### `conversation_get`

通过 `session_key` 返回一个对话。

### `messages_read`

读取一个会话支持对话的最近记录消息。

### `attachments_fetch`

从一条记录消息中提取非文本消息内容块。这是记录内容的元数据视图，不是独立的持久附件 blob 存储。

### `events_poll`

读取自数字游标以来的排队实时事件。

### `events_wait`

长轮询直到下一个匹配的排队事件到达或超时过期。

当通用 MCP 客户端需要近实时传递而不使用 Claude 特定的推送协议时，请使用此工具。

### `messages_send`

通过会话上已记录的相同路由发送文本。

当前行为：

- 需要现有对话路由
- 使用会话的频道、接收者、账户 ID 和线程 ID
- 仅发送文本

### `permissions_list_open`

列出桥接器自连接到 Gateway 以来观察到的待处理 exec/插件批准请求。

### `permissions_respond`

通过以下方式解决一个待处理的 exec/插件批准请求：

- `allow-once`
- `allow-always`
- `deny`

## 事件模型

桥接器在连接时保持内存中事件队列。

当前事件类型：

- `message`
- `exec_approval_requested`
- `exec_approval_resolved`
- `plugin_approval_requested`
- `plugin_approval_resolved`
- `claude_permission_request`

重要限制：

- 队列仅实时；它在 MCP 桥接器启动时开始
- `events_poll` 和 `events_wait` 本身不会重放较早的 Gateway 历史
- 持久积压应使用 `messages_read` 读取

## Claude 频道通知

桥接器还可以暴露 Claude 特定的频道通知。这是 OpenClaw 对应于 Claude Code 频道适配器：标准 MCP 工具仍然可用，但实时入站消息也可以作为 Claude 特定的 MCP 通知到达。

标志：

- `--claude-channel-mode off`：仅标准 MCP 工具
- `--claude-channel-mode on`：启用 Claude 频道通知
- `--claude-channel-mode auto`：当前默认；与 `on` 相同的桥接器行为

当 Claude 频道模式启用时，服务器会声明 Claude 实验功能并可以发出：

- `notifications/claude/channel`
- `notifications/claude/channel/permission`

当前桥接器行为：

- 入站 `user` 记录消息作为 `notifications/claude/channel` 转发
- 通过 MCP 接收的 Claude 权限请求在内存中跟踪
- 如果链接的对话后来发送 `yes abcde` 或 `no abcde`，桥接器会将其转换为 `notifications/claude/channel/permission`
- 这些通知仅限实时会话；如果 MCP 客户端断开连接，则没有推送目标

这是有意为客户端特定的。通用 MCP 客户端应依赖标准轮询工具。

## MCP 客户端配置

示例 stdio 客户端配置：

```json
{
  "mcpServers": {
    "openclaw": {
      "command": "openclaw",
      "args": [
        "mcp",
        "serve",
        "--url",
        "wss://gateway-host:18789",
        "--token-file",
        "/path/to/gateway.token"
      ]
    }
  }
}
```

对于大多数通用 MCP 客户端，从标准工具表面开始，忽略 Claude 模式。仅对实际理解 Claude 特定通知方法的客户端开启 Claude 模式。

## 选项

`openclaw mcp serve` 支持：

- `--url <url>`：Gateway WebSocket URL
- `--token <token>`：Gateway token
- `--token-file <path>`：从文件读取 token
- `--password <password>`：Gateway 密码
- `--password-file <path>`：从文件读取密码
- `--claude-channel-mode <auto|on|off>`：Claude 通知模式
- `-v`, `--verbose`：stderr 上的详细日志

尽可能优先使用 `--token-file` 或 `--password-file` 而不是内联密钥。

## 安全和信任边界

桥接器不发明路由。它仅暴露 Gateway 已经知道如何路由的对话。

这意味着：

- 发送者允许列表、配对和频道级信任仍属于底层 OpenClaw 频道配置
- `messages_send` 只能通过现有存储路由回复
- 批准状态仅在当前桥接器会话期间是实时/内存中的
- 桥接器认证应使用与任何其他远程 Gateway 客户端相同的 Gateway token 或密码控制

如果 `conversations_list` 缺少对话，通常原因不是 MCP 配置。而是底层 Gateway 会话中缺少或不完整的路由元数据。

## 测试

OpenClaw 为此桥接器提供了一个确定性的 Docker 冒烟测试：

```bash
pnpm test:docker:mcp-channels
```

该冒烟测试：

- 启动一个带种子的 Gateway 容器
- 启动第二个生成 `openclaw mcp serve` 的容器
- 验证对话发现、记录读取、附件元数据读取、实时事件队列行为和出站发送路由
- 通过真实 stdio MCP 桥接器验证 Claude 风格频道和权限通知

这是在不将真实 Telegram、Discord 或 iMessage 账户接入测试运行的情况下证明桥接器工作的最快方法。

有关更广泛的测试上下文，请参阅 [测试](/help/testing)。

## 故障排除

### 没有返回对话

通常意味着 Gateway 会话尚不可路由。确认底层会话具有存储的 channel/provider、接收者以及可选的 account/thread 路由元数据。

### `events_poll` 或 `events_wait` 遗漏较早的消息

这是预期的。实时队列在桥接器连接时开始。使用 `messages_read` 读取较早的记录历史。

### Claude 通知不显示

检查所有这些：

- 客户端保持 stdio MCP 会话打开
- `--claude-channel-mode` 是 `on` 或 `auto`
- 客户端实际上理解 Claude 特定的通知方法
- 入站消息发生在桥接器连接之后

### 缺少批准

`permissions_list_open` 仅显示桥接器连接期间观察到的批准请求。它不是持久的批准历史 API。

## OpenClaw 作为 MCP 客户端注册表

这是 `openclaw mcp list`、`show`、`set` 和 `unset` 路径。

这些命令不会通过 MCP 暴露 OpenClaw。它们管理 OpenClaw 配置中 `mcp.servers` 下的 OpenClaw 拥有的 MCP 服务器定义。

这些保存的定义用于 OpenClaw 稍后启动或配置的时刻，例如嵌入式 Pi 和其他运行时适配器。OpenClaw 集中存储定义，因此这些运行时不需要维护自己的重复 MCP 服务器列表。

重要行为：

- 这些命令仅读取或写入 OpenClaw 配置
- 它们不会连接到目标 MCP 服务器
- 它们不会验证命令、URL 或远程传输当前是否可访问
- 运行时适配器在执行时决定它们实际支持哪些传输形状

## 保存的 MCP 服务器定义

OpenClaw 还在配置中存储了一个轻量级 MCP 服务器注册表，用于想要 OpenClaw 管理的 MCP 定义的面。

命令：

- `openclaw mcp list`
- `openclaw mcp show [name]`
- `openclaw mcp set <name> <json>`
- `openclaw mcp unset <name>`

示例：

```bash
openclaw mcp list
openclaw mcp show context7 --json
openclaw mcp set context7 '{"command":"uvx","args":["context7-mcp"]}'
openclaw mcp set docs '{"url":"https://mcp.example.com"}'
openclaw mcp unset context7
```

示例配置形状：

```json
{
  "mcp": {
    "servers": {
      "context7": {
        "command": "uvx",
        "args": ["context7-mcp"]
      },
      "docs": {
        "url": "https://mcp.example.com"
      }
    }
  }
}
```

典型字段：

- `command`
- `args`
- `env`
- `cwd` 或 `workingDirectory`
- `url`

这些命令仅管理保存的配置。它们不会启动频道桥接器、打开实时 MCP 客户端会话或证明目标服务器可访问。

## 当前限制

本文档记录了今天发货的桥接器。

当前限制：

- 对话发现取决于现有 Gateway 会话路由元数据
- 除了 Claude 特定适配器外没有通用推送协议
- 尚无消息编辑或反应工具
- 尚无专用 HTTP MCP 传输
- `permissions_list_open` 仅包括桥接器连接期间观察到的批准