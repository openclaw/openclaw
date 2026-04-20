---
summary: "mac 应用如何嵌入网关 WebChat 以及如何调试它"
read_when:
  - 调试 mac WebChat 视图或环回端口
title: "WebChat (macOS)"
---

# WebChat（macOS 应用）

macOS 菜单栏应用将 WebChat UI 嵌入为原生 SwiftUI 视图。它连接到 Gateway 并默认使用所选代理的**主会话**（带有其他会话的会话切换器）。

- **本地模式**：直接连接到本地 Gateway WebSocket。
- **远程模式**：通过 SSH 转发 Gateway 控制端口并使用该隧道作为数据平面。

## 启动和调试

- 手动：Lobster 菜单 → "Open Chat"。
- 测试自动打开：

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- 日志：`./scripts/clawlog.sh`（子系统 `ai.openclaw`，类别 `WebChatSwiftUI`）。

## 连接方式

- 数据平面：Gateway WS 方法 `chat.history`、`chat.send`、`chat.abort`、`chat.inject` 和事件 `chat`、`agent`、`presence`、`tick`、`health`。
- `chat.history` 返回显示规范化的转录行：内联指令标签从可见文本中剥离，纯文本工具调用 XML 有效负载（包括 `<tool_call>...</tool_call>`、`<function_call>...</function_call>`、`<tool_calls>...</tool_calls>`、`<function_calls>...</function_calls>` 和截断的工具调用块）和泄露的 ASCII/全角模型控制令牌被剥离，纯静音令牌助手行（如确切的 `NO_REPLY` / `no_reply`）被省略，过大的行可以被占位符替换。
- 会话：默认为主要会话（`main`，或当范围为全局时为 `global`）。UI 可以在会话之间切换。
- 入职使用专用会话，将首次运行设置分开。

## 安全表面

- 远程模式仅通过 SSH 转发 Gateway WebSocket 控制端口。

## 已知限制

- UI 针对聊天会话进行了优化（不是完整的浏览器沙盒）。
