# OpenClaw ACP 桥接

本文档描述了 OpenClaw ACP（代理客户端协议）桥接的工作原理，
它如何将 ACP 会话映射到网关会话，以及 IDE 应该如何调用它。

## 概述

`openclaw acp` 通过标准输入/输出暴露 ACP 代理，并通过 WebSocket 将提示转发到运行中的
OpenClaw 网关。它保持 ACP 会话 ID 映射到网关会话密钥，以便 IDE 可以重新连接到同一个代理记录或根据请求重置它。

关键目标：

- 最小 ACP 表面积（标准输入/输出，NDJSON）。
- 跨重新连接的稳定会话映射。
- 与现有的网关会话存储一起工作（列出/解析/重置）。
- 安全默认值（默认情况下隔离的 ACP 会话密钥）。

## 桥接范围

`openclaw acp` 是一个网关支持的 ACP 桥接，不是完整的 ACP 原生编辑器
运行时。它设计用于将 IDE 提示路由到现有的 OpenClaw 网关
会话，具有可预测的会话映射和基本的流式更新。

## 兼容性矩阵

| ACP 区域                                                              | 状态      | 说明                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `initialize`, `newSession`, `prompt`, `cancel`                        | 已实现 | 核心桥接流程通过标准输入/输出到网关 chat/send + abort。                                                                                                                                                                                        |
| `listSessions`，斜杠命令                                        | 已实现 | 会话列表针对网关会话状态工作；命令通过 `available_commands_update` 进行广告。                                                                                                                                       |
| `loadSession`                                                         | 部分 | 将 ACP 会话重新绑定到网关会话密钥并重放存储的用户/助手文本历史。工具/系统历史尚未重建。                                                                                                   |
| 提示内容（`text`，嵌入的 `resource`，图像）                  | 部分 | 文本/资源被展平为聊天输入；图像成为网关附件。                                                                                                                                                                 |
| 会话模式                                                         | 部分 | 支持 `session/set_mode`，桥接暴露初始的网关支持的会话控件，用于思考级别、工具详细程度、推理、使用细节和提升操作。更广泛的 ACP 原生模式/配置表面仍然超出范围。 |
| 会话信息和使用更新                                        | 部分 | 桥接从缓存的网关会话快照中发出 `session_info_update` 和尽力而为的 `usage_update` 通知。使用是近似的，仅在网关令牌总数标记为新鲜时发送。                                        |
| 工具流                                                        | 部分 | `tool_call` / `tool_call_update` 事件包括原始 I/O、文本内容和当网关工具参数/结果暴露它们时的尽力而为的文件位置。嵌入式终端和更丰富的差异原生输出仍未暴露。                        |
| 每会话 MCP 服务器（`mcpServers`）                                | 不支持 | 桥接模式拒绝每会话 MCP 服务器请求。改为在 OpenClaw 网关或代理上配置 MCP。                                                                                                                                     |
| 客户端文件系统方法（`fs/read_text_file`，`fs/write_text_file`） | 不支持 | 桥接不调用 ACP 客户端文件系统方法。                                                                                                                                                                                          |
| 客户端终端方法（`terminal/*`）                                | 不支持 | 桥接不创建 ACP 客户端终端或通过工具调用流式传输终端 ID。                                                                                                                                                       |
| 会话计划 / 思考流                                     | 不支持 | 桥接当前发出输出文本和工具状态，而不是 ACP 计划或思考更新。                                                                                                                                                         |

## 已知限制

- `loadSession` 重放存储的用户和助手文本历史，但它不
  重建历史工具调用、系统通知或更丰富的 ACP 原生事件
  类型。
- 如果多个 ACP 客户端共享同一个网关会话密钥，事件和取消
  路由是尽力而为的，而不是严格隔离每个客户端。当您需要干净的编辑器本地
  回合时，首选默认的隔离 `acp:<uuid>` 会话。
- 网关停止状态被转换为 ACP 停止原因，但该映射
  不如完全 ACP 原生运行时表达。
- 初始会话控件目前显示网关旋钮的一个集中子集：
  思考级别、工具详细程度、推理、使用细节和提升
  操作。模型选择和执行主机控件尚未作为 ACP
  配置选项暴露。
- `session_info_update` 和 `usage_update` 派生自网关会话
  快照，而不是实时 ACP 原生运行时会计。使用是近似的，
  不携带成本数据，仅在网关将总令牌
  数据标记为新鲜时发出。
- 工具跟随数据是尽力而为的。桥接可以显示出现在已知工具参数/结果中的文件路径，但它尚未发出 ACP 终端或
  结构化文件差异。

## 如何使用

当 IDE 或工具使用代理客户端协议并且您希望它驱动 OpenClaw 网关会话时，使用 ACP。

快速步骤：

1. 运行网关（本地或远程）。
2. 配置网关目标（`gateway.remote.url` + 认证）或传递标志。
3. 将 IDE 指向通过标准输入/输出运行 `openclaw acp`。

示例配置：

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

示例运行：

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## 选择代理

ACP 不直接选择代理。它通过网关会话密钥路由。

使用代理范围的会话密钥来定位特定代理：

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

每个 ACP 会话映射到单个网关会话密钥。一个代理可以有多个
会话；ACP 默认为隔离的 `acp:<uuid>` 会话，除非您覆盖
密钥或标签。

## Zed 编辑器设置

在 `~/.config/zed/settings.json` 中添加自定义 ACP 代理：

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

要定位特定的网关或代理：

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

在 Zed 中，打开代理面板并选择 "OpenClaw ACP" 开始一个线程。

## 执行模型

- ACP 客户端生成 `openclaw acp` 并通过标准输入/输出发送 ACP 消息。
- 桥接使用现有认证配置（或 CLI 标志）连接到网关。
- ACP `prompt` 转换为网关 `chat.send`。
- 网关流式事件被转换回 ACP 流式事件。
- ACP `cancel` 映射到活动运行的网关 `chat.abort`。

## 会话映射

默认情况下，每个 ACP 会话映射到专用的网关会话密钥：

- `acp:<uuid>` 除非被覆盖。

您可以通过两种方式覆盖或重用会话：

1. CLI 默认值

```bash
openclaw acp --session agent:main:main
openclaw acp --session-label "support inbox"
openclaw acp --reset-session
```

2. 每个会话的 ACP 元数据

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true,
    "requireExisting": false
  }
}
```

规则：

- `sessionKey`：直接网关会话密钥。
- `sessionLabel`：通过标签解析现有会话。
- `resetSession`：在首次使用前为密钥创建新记录。
- `requireExisting`：如果密钥/标签不存在则失败。

### 会话列表

ACP `listSessions` 映射到网关 `sessions.list` 并返回适合 IDE 会话选择器的过滤
摘要。`_meta.limit` 可以限制返回的会话数量。

## 提示转换

ACP 提示输入被转换为网关 `chat.send`：

- `text` 和 `resource` 块成为提示文本。
- 具有图像 mime 类型的 `resource_link` 成为附件。
- 工作目录可以前缀到提示中（默认开启，可以通过 `--no-prefix-cwd` 禁用）。

网关流式事件被转换为 ACP `message` 和 `tool_call`
更新。终端网关状态映射到带有停止原因的 ACP `done`：

- `complete` -> `stop`
- `aborted` -> `cancel`
- `error` -> `error`

## 认证 + 网关发现

`openclaw acp` 从 CLI 标志或配置解析网关 URL 和认证：

- `--url` / `--token` / `--password` 优先。
- 否则使用配置的 `gateway.remote.*` 设置。

## 操作说明

- ACP 会话在桥接进程生命周期内存储在内存中。
- 网关会话状态由网关本身持久化。
- `--verbose` 将 ACP/网关桥接事件记录到 stderr（永远不会到 stdout）。
- ACP 运行可以被取消，活动运行 ID 按会话跟踪。

## 兼容性

- ACP 桥接使用 `@agentclientprotocol/sdk`（当前为 0.15.x）。
- 适用于实现 `initialize`、`newSession`、
  `loadSession`、`prompt`、`cancel` 和 `listSessions` 的 ACP 客户端。
- 桥接模式拒绝每会话 `mcpServers`，而不是默默地忽略
  它们。在网关或代理层配置 MCP。

## 测试

- 单元：`src/acp/session.test.ts` 涵盖运行 ID 生命周期。
- 完整门：`pnpm build && pnpm check && pnpm test && pnpm docs:build`。

## 相关文档

- CLI 使用：`docs/cli/acp.md`
- 会话模型：`docs/concepts/session.md`
- 会话管理内部：`docs/reference/session-management-compaction.md`