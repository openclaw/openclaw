---
read_when:
  - 调试 Mac WebChat 视图或 local loopback 端口
summary: Mac 应用如何嵌入 Gateway网关 WebChat 以及如何调试
title: WebChat
x-i18n:
  generated_at: "2026-02-01T21:33:23Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 04ff448758e530098e2004625f33e42fc3dbe31137cd3beec2d55590e507de08
  source_path: platforms/mac/webchat.md
  workflow: 15
---

# WebChat（macOS 应用）

macOS 菜单栏应用将 WebChat UI 嵌入为原生 SwiftUI 视图。它连接到 Gateway网关，默认使用所选智能体的**主会话**（通过会话切换器可访问其他会话）。

- **本地模式**：直接连接到本地 Gateway网关 WebSocket。
- **远程模式**：通过 SSH 转发 Gateway网关控制端口，并使用该隧道作为数据平面。

## 启动与调试

- 手动：Lobster 菜单 → "Open Chat"。
- 测试时自动打开：
  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```
- 日志：`./scripts/clawlog.sh`（子系统 `bot.molt`，类别 `WebChatSwiftUI`）。

## 工作原理

- 数据平面：Gateway网关 WS 方法 `chat.history`、`chat.send`、`chat.abort`、`chat.inject` 以及事件 `chat`、`agent`、`presence`、`tick`、`health`。
- 会话：默认使用主会话（`main`，或作用域为全局时使用 `global`）。UI 可在会话之间切换。
- 新手引导使用专用会话，以将首次运行设置与其他内容分开。

## 安全面

- 远程模式仅通过 SSH 转发 Gateway网关 WebSocket 控制端口。

## 已知限制

- UI 针对聊天会话进行了优化（不是完整的浏览器沙箱）。
