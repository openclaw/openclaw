---
summary: "通过MCP暴露OpenClaw频道对话并管理保存的MCP服务器定义"
read_when:
  - 将Codex、Claude Code或其他MCP客户端连接到OpenClaw支持的频道
  - 运行`openclaw mcp serve`
  - 管理OpenClaw保存的MCP服务器定义
title: "mcp"
---

# mcp

`openclaw mcp`有两个工作：

- 使用`openclaw mcp serve`运行OpenClaw作为MCP服务器
- 使用`list`、`show`、`set`和`unset`管理OpenClaw拥有的出站MCP服务器定义

换句话说：

- `serve`是OpenClaw作为MCP服务器
- `list` / `show` / `set` / `unset`是OpenClaw作为MCP客户端端注册表，用于其运行时稍后可能消费的其他MCP服务器

当OpenClaw应该自己托管编码harness会话并通过ACP路由该运行时时，使用[`openclaw acp`](/cli/acp)。

## OpenClaw作为MCP服务器

这是`openclaw mcp serve`路径。

## 何时使用`serve`

在以下情况使用`openclaw mcp serve`：

- Codex、Claude Code或其他MCP客户端应该直接与OpenClaw支持的频道对话
- 您已经有一个带有路由会话的本地或远程OpenClaw Gateway
- 您想要一个跨OpenClaw频道后端工作的MCP服务器，而不是运行单独的每个频道桥接

当OpenClaw应该自己托管编码运行时并将代理会话保持在OpenClaw内部时，使用[`openclaw acp`](/cli/acp)代替。

## 工作原理

`openclaw mcp serve`启动一个标准输入/输出MCP服务器。MCP客户端拥有该进程。当客户端保持标准输入/输出会话打开时，桥接通过WebSocket连接到本地或远程OpenClaw Gateway，并通过MCP暴露路由的频道对话。

生命周期：

1. MCP客户端生成`openclaw mcp serve`
2. 桥接连接到Gateway
3. 路由的会话成为MCP对话和记录/历史工具
4. 实时事件在桥接连接时在内存中排队
5. 如果启用了Claude频道模式，同一个会话还可以接收Claude特定的推送通知

重要行为：

- 实时队列状态在桥接连接时开始
- 较旧的记录历史通过`messages_read`读取
- Claude推送通知仅在MCP会话活动时存在
- 当客户端断开连接时，桥接退出，实时队列消失

## 选择客户端模式

以两种不同方式使用同一个桥接：

- 通用MCP客户端：仅标准MCP工具。使用`conversations_list`、`messages_read`、`events_poll`、`events_wait`、`messages_send`和批准工具。
- Claude Code：标准MCP工具加上Claude特定的频道适配器。启用`--claude-channel-mode on`或保持默认`auto`。

今天，`auto`的行为与`on`相同。还没有客户端能力检测。

## `serve`暴露什么

桥接使用现有的Gateway会话路由元数据来暴露频道支持的对话。当OpenClaw已经具有带有已知路由的会话状态时，对话会出现，例如：

- `channel`
- 接收者或目标元数据
- 可选的`accountId`
- 可选的`threadId`

这给MCP客户端一个地方：

- 列出最近的路由对话
- 读取最近的记录历史
- 等待新的入站事件
- 通过同一路由发送回复
- 查看桥接连接时到达的批准请求

## 用法

```bash
# 本地Gateway
openclaw mcp serve

# 远程Gateway
openclaw mcp serve --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token

# 使用密码认证的远程Gateway
openclaw mcp serve --url wss://gateway-host:18789 --password-file ~/.openclaw/gateway.password

# 启用详细的桥接日志
openclaw mcp serve --verbose

# 禁用Claude特定的推送通知
openclaw mcp serve --claude-channel-mode off
```

## 桥接工具

当前桥接暴露这些MCP工具：

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

列出在Gateway会话状态中已经具有路由元数据的最近会话支持的对话。

有用的过滤器：

- `limit`
- `search`
- `channel`
- `includeDerivedTitles`
- `includeLastMessage`

### `conversation_get`

通过`session_key`返回一个对话。

### `messages_read`

读取一个会话支持的对话的最近记录消息。

### `attachments_fetch`

从一个记录消息中提取非文本消息内容块。这是记录内容的元数据视图，不是独立的持久附件blob存储。

### `events_poll`

从数字游标开始读取排队的实时事件。

### `events_wait`

长轮询，直到下一个匹配的排队事件到达或超时过期。

当通用MCP客户端需要近实时交付而不需要Claude特定的推送协议时使用此命令。

### `messages_send`

通过会话上已经记录的同一路由发送文本。

当前行为：

- 需要现有的对话路由
- 使用会话的频道、接收者、账户ID和线程ID
- 仅发送文本

### `permissions_list_open`

列出桥接连接到Gateway后观察到的待处理exec/插件批准请求。

### `permissions_respond`

用以下方式解决一个待处理的exec/插件批准请求：

- `allow-once`
- `allow-always`
- `deny`

## 事件模型

桥接在连接时保持内存中的事件队列。

当前事件类型：

- `message`
- `exec_approval_requested`
- `exec_approval_resolved`
- `plugin_approval_requested`
- `plugin_approval_resolved`
- `claude_permission_request`

重要限制：

- 队列仅实时；它在MCP桥接启动时开始
- `events_poll`和`events_wait`本身不会重放较旧的Gateway历史
- 持久积压应该通过`messages_read`读取

## Claude频道通知

桥接还可以暴露Claude特定的频道通知。这是Claude Code频道适配器的OpenClaw等效物：标准MCP工具仍然可用，但实时入站消息也可以作为Claude特定的MCP通知到达。

标志：

- `--claude-channel-mode off`：仅标准MCP工具
- `--claude-channel-mode on`：启用Claude频道通知
- `--claude-channel-mode auto`：当前默认；与`on`相同的桥接行为

当启用Claude频道模式时，服务器会宣传Claude实验性能力，并可以发出：

- `notifications/claude/channel`
- `notifications/claude/channel/permission`

当前桥接行为：

- 入站`user`记录消息被转发为`notifications/claude/channel`
- 通过MCP接收的Claude权限请求在内存中跟踪
- 如果链接的对话后来发送`yes abcde`或`no abcde`，桥接会将其转换为`notifications/claude/channel/permission`
- 这些通知仅在实时会话中；如果MCP客户端断开连接，没有推送目标

这是有意的客户端特定。通用MCP客户端应该依赖标准轮询工具。

## MCP客户端配置

示例标准输入/输出客户端配置：

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

对于大多数通用MCP客户端，从标准工具表面开始并忽略Claude模式。仅为实际理解Claude特定通知方法的客户端开启Claude模式。

## 选项

`openclaw mcp serve`支持：

- `--url <url>`: Gateway WebSocket URL
- `--token <token>`: Gateway令牌
- `--token-file <path>`: 从文件读取令牌
- `--password <password>`: Gateway密码
- `--password-file <path>`: 从文件读取密码
- `--claude-channel-mode <auto|on|off>`: Claude通知模式
- `-v`, `--verbose`: 在stderr上输出详细日志

尽可能使用`--token-file`或`--password-file`而不是内联秘密。

## 安全和信任边界

桥接不会发明路由。它仅暴露Gateway已经知道如何路由的对话。

这意味着：

- 发送者允许列表、配对和频道级信任仍然属于基础OpenClaw频道配置
- `messages_send`只能通过现有的存储路由回复
- 批准状态仅在当前桥接会话的实时/内存中
- 桥接认证应使用与任何其他远程Gateway客户端相同的Gateway令牌或密码控制

如果对话从`conversations_list`中缺失，通常的原因不是MCP配置。它是基础Gateway会话中缺失或不完整的路由元数据。

## 测试

OpenClaw为此桥接提供确定性的Docker冒烟测试：

```bash
pnpm test:docker:mcp-channels
```

该冒烟测试：

- 启动一个种子Gateway容器
- 启动第二个容器，生成`openclaw mcp serve`
- 验证对话发现、记录读取、附件元数据读取、实时事件队列行为和出站发送路由
- 通过真实的标准输入/输出MCP桥接验证Claude风格的频道和权限通知

这是证明桥接工作而无需将真实的Telegram、Discord或iMessage账户连接到测试运行的最快方法。

有关更广泛的测试上下文，请参阅[Testing](/help/testing)。

## 故障排除

### 没有返回对话

通常意味着Gateway会话尚未可路由。确认基础会话具有存储的频道/提供者、接收者和可选的账户/线程路由元数据。

### `events_poll`或`events_wait`错过较旧的消息

预期行为。实时队列在桥接连接时开始。使用`messages_read`读取较旧的记录历史。

### Claude通知不显示

检查所有这些：

- 客户端保持标准输入/输出MCP会话打开
- `--claude-channel-mode`是`on`或`auto`
- 客户端实际理解Claude特定的通知方法
- 入站消息发生在桥接连接之后

### 批准缺失

`permissions_list_open`仅显示桥接连接时观察到的批准请求。它不是持久的批准历史API。

## OpenClaw作为MCP客户端注册表

这是`openclaw mcp list`、`show`、`set`和`unset`路径。

这些命令不会通过MCP暴露OpenClaw。它们在OpenClaw配置的`mcp.servers`下管理OpenClaw拥有的MCP服务器定义。

这些保存的定义用于OpenClaw稍后启动或配置的运行时，例如嵌入式Pi和其他运行时适配器。OpenClaw集中存储这些定义，因此这些运行时不需要保留自己的重复MCP服务器列表。

重要行为：

- 这些命令仅读取或写入OpenClaw配置
- 它们不连接到目标MCP服务器
- 它们不验证命令、URL或远程传输现在是否可达
- 运行时适配器在执行时决定它们实际支持哪些传输形状

## 保存的MCP服务器定义

OpenClaw还在配置中存储轻量级MCP服务器注册表，用于需要OpenClaw管理的MCP定义的表面。

命令：

- `openclaw mcp list`
- `openclaw mcp show [name]`
- `openclaw mcp set <name> <json>`
- `openclaw mcp unset <name>`

注意事项：

- `list`排序服务器名称。
- `show`没有名称时打印完整配置的MCP服务器对象。
- `set`在命令行上期望一个JSON对象值。
- `unset`如果命名服务器不存在则失败。

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

### 标准输入/输出传输

启动本地子进程并通过标准输入/输出通信。

| 字段                       | 描述                       |
| -------------------------- | -------------------------- |
| `command`                  | 要生成的可执行文件（必需） |
| `args`                     | 命令行参数数组             |
| `env`                      | 额外的环境变量             |
| `cwd` / `workingDirectory` | 进程的工作目录             |

### SSE / HTTP传输

通过HTTP Server-Sent Events连接到远程MCP服务器。

| 字段                  | 描述                                 |
| --------------------- | ------------------------------------ |
| `url`                 | 远程服务器的HTTP或HTTPS URL（必需）  |
| `headers`             | HTTP头的可选键值映射（例如认证令牌） |
| `connectionTimeoutMs` | 每服务器连接超时（毫秒）（可选）     |

示例：

```json
{
  "mcp": {
    "servers": {
      "remote-tools": {
        "url": "https://mcp.example.com",
        "headers": {
          "Authorization": "Bearer <token>"
        }
      }
    }
  }
}
```

`url`（userinfo）和`headers`中的敏感值在日志和状态输出中被编辑。

### 可流式HTTP传输

`streamable-http`是`sse`和`stdio`之外的另一个传输选项。它使用HTTP流与远程MCP服务器进行双向通信。

| 字段                  | 描述                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `url`                 | 远程服务器的HTTP或HTTPS URL（必需）                              |
| `transport`           | 设置为`"streamable-http"`以选择此传输；省略时，OpenClaw使用`sse` |
| `headers`             | HTTP头的可选键值映射（例如认证令牌）                             |
| `connectionTimeoutMs` | 每服务器连接超时（毫秒）（可选）                                 |

示例：

```json
{
  "mcp": {
    "servers": {
      "streaming-tools": {
        "url": "https://mcp.example.com/stream",
        "transport": "streamable-http",
        "connectionTimeoutMs": 10000,
        "headers": {
          "Authorization": "Bearer <token>"
        }
      }
    }
  }
}
```

这些命令仅管理保存的配置。它们不会启动频道桥接、打开实时MCP客户端会话或证明目标服务器可达。

## 当前限制

本页面记录了今天发布的桥接。

当前限制：

- 对话发现依赖于现有的Gateway会话路由元数据
- 除Claude特定适配器外，没有通用推送协议
- 尚无消息编辑或反应工具
- HTTP/SSE/streamable-http传输连接到单个远程服务器；尚未实现多路复用上游
- `permissions_list_open`仅包括桥接连接时观察到的批准
