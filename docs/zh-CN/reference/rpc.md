---
read_when:
  - 添加或修改外部 CLI 集成
  - 调试 RPC 适配器（signal-cli、imsg）
summary: 外部 CLI（signal-cli、imsg）的 RPC 适配器及 Gateway网关模式
title: RPC 适配器
x-i18n:
  generated_at: "2026-02-01T21:37:06Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: c04edc952390304a22a3a4763aca00a0311b38d390477ec0be5fe485ec257fa7
  source_path: reference/rpc.md
  workflow: 15
---

# RPC 适配器

OpenClaw 通过 JSON-RPC 集成外部 CLI。目前使用两种模式。

## 模式 A：HTTP 守护进程（signal-cli）

- `signal-cli` 作为守护进程运行，通过 HTTP 提供 JSON-RPC。
- 事件流使用 SSE（`/api/v1/events`）。
- 健康探测：`/api/v1/check`。
- 当 `channels.signal.autoStart=true` 时，OpenClaw 管理其生命周期。

设置和端点详见 [Signal](/channels/signal)。

## 模式 B：stdio 子进程（imsg）

- OpenClaw 将 `imsg rpc` 作为子进程启动。
- JSON-RPC 通过 stdin/stdout 以行分隔传输（每行一个 JSON 对象）。
- 无需 TCP 端口，无需守护进程。

使用的核心方法：

- `watch.subscribe` → 通知（`method: "message"`）
- `watch.unsubscribe`
- `send`
- `chats.list`（探测/诊断）

设置和寻址方式（推荐使用 `chat_id`）详见 [iMessage](/channels/imessage)。

## 适配器指南

- Gateway网关管理进程（启动/停止与提供商生命周期绑定）。
- 保持 RPC 客户端的弹性：超时、退出时重启。
- 优先使用稳定 ID（例如 `chat_id`）而非显示字符串。
