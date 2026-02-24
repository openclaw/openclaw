# TUI（终端聊天界面）详解

## 概述

TUI 是 OpenClaw 的终端聊天界面，通过 `openclaw tui` 命令启动。它在终端中提供一个全功能的聊天客户端，支持与 AI Agent 实时对话、工具调用展示、会话管理、模型切换等。和 Control UI（Web）一样，TUI 通过 WebSocket 连接 Gateway，不直接调用 AI Provider。

## 启动命令

```bash
# 基本启动
openclaw tui

# 指定 Gateway 地址和 token
openclaw tui --url ws://localhost:18789 --token <token>

# 指定会话
openclaw tui --session my-session

# 发送一条消息后进入交互模式
openclaw tui --message "你好"

# 开发模式
pnpm dev -- tui
```

## 技术栈

| 层级     | 技术                                                             |
| -------- | ---------------------------------------------------------------- |
| 终端渲染 | 自研 TUI 框架（`Container`、`Text`、`ChatLog`、`Editor` 等组件） |
| 通信     | `GatewayChatClient`（封装 `GatewayClient` WebSocket）            |
| Markdown | 自研终端 Markdown 渲染（支持 OSC8 超链接）                       |
| 自动补全 | `CombinedAutocompleteProvider`（斜杠命令 + 文件路径）            |
| 模糊搜索 | 内置 fuzzy filter（用于模型/Agent/会话选择器）                   |
| 语言     | TypeScript（ESM）                                                |

## 架构

```
┌──────────────────────────────────────────────────┐
│                  终端 (TTY)                       │
│                                                   │
│  ┌──────────────────────────────────────────────┐ │
│  │  Header: gateway url / agent / session       │ │
│  ├──────────────────────────────────────────────┤ │
│  │  ChatLog: 消息流（用户/助手/系统/工具）       │ │
│  ├──────────────────────────────────────────────┤ │
│  │  Status: 连接状态 / 活动状态 / 等待动画      │ │
│  ├──────────────────────────────────────────────┤ │
│  │  Footer: agent / session / model / tokens    │ │
│  ├──────────────────────────────────────────────┤ │
│  │  Editor: 多行输入框（自动补全 + 历史）        │ │
│  └──────────────────────────────────────────────┘ │
└──────────────────────┬───────────────────────────┘
                       │ WebSocket
┌──────────────────────▼───────────────────────────┐
│                 Gateway Server                    │
│  chat.send / chat.history / chat.abort            │
│  sessions.list / sessions.patch / models.list     │
└──────────────────────┬───────────────────────────┘
                       │
                 AI Provider
```

## 核心组件

### GatewayChatClient（`gateway-chat.ts`）

TUI 专用的 Gateway WebSocket 客户端，封装了所有 RPC 方法：

| 方法             | Gateway RPC      | 说明              |
| ---------------- | ---------------- | ----------------- |
| `sendChat()`     | `chat.send`      | 发送聊天消息      |
| `abortChat()`    | `chat.abort`     | 中断当前对话      |
| `loadHistory()`  | `chat.history`   | 加载聊天历史      |
| `listSessions()` | `sessions.list`  | 列出会话          |
| `patchSession()` | `sessions.patch` | 修改会话属性      |
| `resetSession()` | `sessions.reset` | 重置会话          |
| `listAgents()`   | `agents.list`    | 列出 Agent        |
| `listModels()`   | `models.list`    | 列出可用模型      |
| `getStatus()`    | `status`         | 获取 Gateway 状态 |

连接参数解析优先级：命令行参数 → 环境变量 → 配置文件（支持 local/remote 模式）。

### TUI 渲染组件（`components/`）

| 组件                        | 说明                                      |
| --------------------------- | ----------------------------------------- |
| `chat-log.ts`               | 聊天消息列表，管理用户/助手/系统/工具消息 |
| `custom-editor.ts`          | 多行文本编辑器，支持自动补全和输入历史    |
| `assistant-message.ts`      | 助手消息渲染（支持流式更新）              |
| `user-message.ts`           | 用户消息渲染                              |
| `tool-execution.ts`         | 工具调用卡片（名称、参数、输出）          |
| `markdown-message.ts`       | 终端 Markdown 渲染                        |
| `hyperlink-markdown.ts`     | OSC8 超链接支持                           |
| `filterable-select-list.ts` | 可过滤选择列表（用于 overlay 选择器）     |
| `selectors.ts`              | 模型/Agent/会话选择器                     |

### 事件处理（`tui-event-handlers.ts`）

处理来自 Gateway 的两类 WebSocket 事件：

- `chat` 事件：
  - `delta` → 调用 `TuiStreamAssembler` 组装流式文本 → `chatLog.updateAssistant()`
  - `final` → 最终化消息 → `chatLog.finalizeAssistant()`
  - `aborted` / `error` → 显示系统消息，清理状态

- `agent` 事件：
  - `stream: "tool"` → 工具调用展示（start/update/result 三阶段）
  - `stream: "lifecycle"` → 更新活动状态（running/idle/error）

### 命令处理（`tui-command-handlers.ts`）

处理用户输入的斜杠命令和消息发送：

| 命令         | 说明                 |
| ------------ | -------------------- |
| `/new`       | 重置当前会话         |
| `/session`   | 切换会话             |
| `/agent`     | 切换 Agent           |
| `/model`     | 切换模型             |
| `/think`     | 设置 thinking level  |
| `/verbose`   | 设置 verbose level   |
| `/reasoning` | 设置 reasoning level |
| `/status`    | 显示会话状态         |
| `/deliver`   | 切换消息投递模式     |
| `/exit`      | 退出 TUI             |

普通文本消息通过 `sendChat()` 发送到 Gateway。

### 流式文本组装（`tui-stream-assembler.ts`）

`TuiStreamAssembler` 负责将 Gateway 推送的 delta 事件组装成完整文本：

- 每个 `runId` 维护独立的文本缓冲
- 支持 thinking 标签的显示/隐藏
- `ingestDelta()` 接收增量文本
- `finalize()` 输出最终完整文本

### 本地 Shell（`tui-local-shell.ts`）

以 `!` 开头的输入会作为本地 shell 命令执行（不经过 Gateway），输出直接显示在 ChatLog 中。

### Overlay 系统（`tui-overlays.ts`）

模型选择器、Agent 选择器、会话选择器等通过 overlay 模式展示，支持模糊搜索和键盘导航。

## 快捷键

| 快捷键 | 功能                  |
| ------ | --------------------- |
| Enter  | 发送消息              |
| Escape | 中断当前 AI 对话      |
| Ctrl+C | 清空输入 / 再按退出   |
| Ctrl+D | 退出 TUI              |
| Ctrl+O | 展开/折叠工具调用详情 |
| Ctrl+L | 打开模型选择器        |
| Ctrl+G | 打开 Agent 选择器     |
| Ctrl+P | 打开会话选择器        |
| Ctrl+T | 切换 thinking 显示    |

## 消息发送流程

```
用户输入 → Editor.onSubmit
  │
  ├─ 以 / 开头 → handleCommand() → 斜杠命令处理
  ├─ 以 ! 开头 → runLocalShellLine() → 本地 shell 执行
  └─ 普通文本 → sendMessage()
                    │
                    ▼
              GatewayChatClient.sendChat()
                    │
                    ▼ WebSocket RPC: chat.send
              Gateway 处理 → AI Provider
                    │
                    ▼ WebSocket 事件推送
              handleChatEvent() / handleAgentEvent()
                    │
                    ├─ delta → StreamAssembler → chatLog.updateAssistant()
                    ├─ tool  → chatLog.startTool() / updateToolResult()
                    └─ final → chatLog.finalizeAssistant()
                    │
                    ▼
              终端重新渲染
```

## 与 Control UI 的对比

| 特性       | TUI                   | Control UI (Web)         |
| ---------- | --------------------- | ------------------------ |
| 运行环境   | 终端 (TTY)            | 浏览器                   |
| 通信方式   | WebSocket（相同协议） | WebSocket（相同协议）    |
| 认证方式   | Token / Password      | Token + Ed25519 设备身份 |
| 渲染       | 自研终端组件          | Lit Web Components       |
| Markdown   | 终端 ANSI 渲染        | marked + DOMPurify       |
| 图片支持   | 不支持                | 支持（base64 附件）      |
| 本地 Shell | 支持（`!` 前缀）      | 不支持                   |
| 模型切换   | Ctrl+L overlay        | 配置页面                 |

## 相关源码路径

| 文件                              | 说明                             |
| --------------------------------- | -------------------------------- |
| `src/tui/tui.ts`                  | TUI 主入口（`runTui`）           |
| `src/tui/gateway-chat.ts`         | Gateway WebSocket 客户端         |
| `src/tui/tui-event-handlers.ts`   | chat/agent 事件处理              |
| `src/tui/tui-command-handlers.ts` | 斜杠命令和消息发送               |
| `src/tui/tui-stream-assembler.ts` | 流式文本组装器                   |
| `src/tui/tui-session-actions.ts`  | 会话操作（加载历史、切换、刷新） |
| `src/tui/tui-local-shell.ts`      | 本地 shell 命令执行              |
| `src/tui/tui-overlays.ts`         | Overlay 系统（选择器弹窗）       |
| `src/tui/tui-formatters.ts`       | 消息格式化工具                   |
| `src/tui/tui-waiting.ts`          | 等待状态动画                     |
| `src/tui/tui-types.ts`            | 类型定义                         |
| `src/tui/commands.ts`             | 斜杠命令定义                     |
| `src/tui/theme/`                  | 终端主题和颜色                   |
| `src/tui/components/`             | TUI 渲染组件                     |
