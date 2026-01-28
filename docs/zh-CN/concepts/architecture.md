---
read_when:
  - 处理 Gateway网关协议、客户端或传输层相关工作时
summary: WebSocket Gateway网关架构、组件和客户端流程
title: Gateway网关架构
x-i18n:
  generated_at: "2026-02-01T20:22:27Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: c636d5d8a5e628067432b30671466309e3d630b106d413f1708765bf2a9399a1
  source_path: concepts/architecture.md
  workflow: 14
---

# Gateway网关架构

最后更新：2026-01-22

## 概述

- 单个长生命周期的 **Gateway网关** 管理所有消息接入面（通过 Baileys 接入 WhatsApp、通过 grammY 接入 Telegram、Slack、Discord、Signal、iMessage、WebChat）。
- 控制面客户端（macOS 应用、CLI、Web UI、自动化）通过 **WebSocket** 连接到 Gateway网关，使用配置的绑定地址（默认 `127.0.0.1:18789`）。
- **节点**（macOS/iOS/Android/无头模式）也通过 **WebSocket** 连接，但声明 `role: node` 并显式指定能力/命令。
- 每台主机一个 Gateway网关；它是唯一打开 WhatsApp 会话的位置。
- **画布主机**（默认 `18793`）提供智能体可编辑的 HTML 和 A2UI。

## 组件和流程

### Gateway网关（守护进程）

- 维护提供商连接。
- 暴露类型化的 WS API（请求、响应、服务端推送事件）。
- 根据 JSON Schema 验证入站帧。
- 发出 `agent`、`chat`、`presence`、`health`、`heartbeat`、`cron` 等事件。

### 客户端（Mac 应用 / CLI / Web 管理端）

- 每个客户端一个 WS 连接。
- 发送请求（`health`、`status`、`send`、`agent`、`system-presence`）。
- 订阅事件（`tick`、`agent`、`presence`、`shutdown`）。

### 节点（macOS / iOS / Android / 无头模式）

- 连接到**同一个 WS 服务器**，声明 `role: node`。
- 在 `connect` 中提供设备身份；配对是**基于设备**的（角色为 `node`），审批信息存储在设备配对存储中。
- 暴露 `canvas.*`、`camera.*`、`screen.record`、`location.get` 等命令。

协议详情：

- [Gateway网关协议](/gateway/protocol)

### WebChat

- 静态 UI，使用 Gateway网关 WS API 获取聊天历史和发送消息。
- 在远程设置中，通过与其他客户端相同的 SSH/Tailscale 隧道连接。

## 连接生命周期（单个客户端）

```
Client                    Gateway网关
  |                          |
  |---- req:connect -------->|
  |<------ res (ok) ---------|   （或 res error + 关闭）
  |   （payload=hello-ok 携带快照：presence + health）
  |                          |
  |<------ event:presence ---|
  |<------ event:tick -------|
  |                          |
  |------- req:agent ------->|
  |<------ res:agent --------|   （确认：{runId,status:"accepted"}）
  |<------ event:agent ------|   （流式传输）
  |<------ res:agent --------|   （最终：{runId,status,summary}）
  |                          |
```

## 线路协议（摘要）

- 传输层：WebSocket，文本帧携带 JSON 负载。
- 第一帧**必须**是 `connect`。
- 握手完成后：
  - 请求：`{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - 事件：`{type:"event", event, payload, seq?, stateVersion?}`
- 如果设置了 `OPENCLAW_GATEWAY_TOKEN`（或 `--token`），`connect.params.auth.token` 必须匹配，否则套接字将关闭。
- 有副作用的方法（`send`、`agent`）需要幂等性键以安全重试；服务器维护一个短期去重缓存。
- 节点必须在 `connect` 中包含 `role: "node"` 以及能力/命令/权限。

## 配对与本地信任

- 所有 WS 客户端（操作员 + 节点）在 `connect` 时包含**设备身份**。
- 新设备 ID 需要配对审批；Gateway网关颁发**设备令牌**用于后续连接。
- **本地**连接（local loopback 或 Gateway网关主机自身的 tailnet 地址）可以自动审批，以保持同主机用户体验的流畅性。
- **非本地**连接必须对 `connect.challenge` nonce 签名，并需要显式审批。
- Gateway网关认证（`gateway.auth.*`）仍适用于**所有**连接，无论本地还是远程。

详情：[Gateway网关协议](/gateway/protocol)、[配对](/start/pairing)、[安全](/gateway/security)。

## 协议类型定义与代码生成

- TypeBox schema 定义协议。
- 从这些 schema 生成 JSON Schema。
- 从 JSON Schema 生成 Swift 模型。

## 远程访问

- 推荐方式：Tailscale 或 VPN。
- 备选方式：SSH 隧道
  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```
- 相同的握手 + 认证令牌适用于隧道连接。
- 远程设置中可为 WS 启用 TLS + 可选的证书固定。

## 运维概览

- 启动：`openclaw gateway`（前台运行，日志输出到 stdout）。
- 健康检查：通过 WS 发送 `health`（也包含在 `hello-ok` 中）。
- 监管：使用 launchd/systemd 实现自动重启。

## 不变量

- 每台主机恰好一个 Gateway网关控制单个 Baileys 会话。
- 握手是强制的；任何非 JSON 或非 connect 的首帧将导致硬关闭。
- 事件不会重放；客户端必须在出现间隙时刷新。
