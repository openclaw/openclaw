---
read_when:
  - 构建或调试节点客户端（iOS/Android/macOS 节点模式）
  - 排查配对或桥接认证故障
  - 审计 Gateway网关暴露的节点接口
summary: 桥接协议（旧版节点）：TCP JSONL、配对、作用域 RPC
title: 桥接协议
x-i18n:
  generated_at: "2026-02-01T20:25:34Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 789bcf3cbc6841fc293e054b919e63d661b3cc4cd205b2094289f00800127fe2
  source_path: gateway/bridge-protocol.md
  workflow: 14
---

# 桥接协议（旧版节点传输）

桥接协议是一种**旧版**节点传输方式（TCP JSONL）。新的节点客户端应改用统一的 Gateway网关 WebSocket 协议。

如果你正在构建操作端或节点客户端，请使用 [Gateway网关协议](/gateway/protocol)。

**注意：** 当前版本的 OpenClaw 不再附带 TCP 桥接监听器；本文档仅作历史参考保留。旧版 `bridge.*` 配置键已不再属于配置模式的一部分。

## 为什么有两种协议

- **安全边界**：桥接仅暴露一个小型允许列表，而非完整的 Gateway网关 API 接口。
- **配对与节点身份**：节点准入由 Gateway网关管理，并与每个节点的令牌绑定。
- **发现体验**：节点可以通过局域网上的 Bonjour 发现 Gateway网关，或通过 tailnet 直接连接。
- **local loopback WS**：完整的 WS 控制平面保持在本地，除非通过 SSH 隧道转发。

## 传输方式

- TCP，每行一个 JSON 对象（JSONL）。
- 可选 TLS（当 `bridge.tls.enabled` 为 true 时）。
- 旧版默认监听端口为 `18790`（当前版本不再启动 TCP 桥接）。

启用 TLS 时，发现 TXT 记录会包含 `bridgeTls=1` 以及 `bridgeTlsSha256`，以便节点可以固定证书。

## 握手与配对

1. 客户端发送 `hello`，附带节点元数据和令牌（如果已配对）。
2. 如果未配对，Gateway网关回复 `error`（`NOT_PAIRED`/`UNAUTHORIZED`）。
3. 客户端发送 `pair-request`。
4. Gateway网关等待审批，然后发送 `pair-ok` 和 `hello-ok`。

`hello-ok` 返回 `serverName`，可能包含 `canvasHostUrl`。

## 帧类型

客户端 → Gateway网关：

- `req` / `res`：作用域 Gateway网关 RPC（聊天、会话、配置、健康检查、语音唤醒、skills.bins）
- `event`：节点信号（语音转录、智能体请求、聊天订阅、执行生命周期）

Gateway网关 → 客户端：

- `invoke` / `invoke-res`：节点命令（`canvas.*`、`camera.*`、`screen.record`、`location.get`、`sms.send`）
- `event`：已订阅会话的聊天更新
- `ping` / `pong`：保活

旧版允许列表强制执行逻辑位于 `src/gateway/server-bridge.ts`（已移除）。

## 执行生命周期事件

节点可以发出 `exec.finished` 或 `exec.denied` 事件以展示 system.run 活动。这些会映射为 Gateway网关中的系统事件。（旧版节点可能仍会发出 `exec.started`。）

有效载荷字段（除特别说明外均为可选）：

- `sessionKey`（必填）：接收系统事件的智能体会话。
- `runId`：用于分组的唯一执行 ID。
- `command`：原始或格式化的命令字符串。
- `exitCode`、`timedOut`、`success`、`output`：完成详情（仅限 finished）。
- `reason`：拒绝原因（仅限 denied）。

## Tailnet 使用

- 将桥接绑定到 tailnet IP：在 `~/.openclaw/openclaw.json` 中设置 `bridge.bind: "tailnet"`。
- 客户端通过 MagicDNS 名称或 tailnet IP 连接。
- Bonjour **不能**跨网络；需要时请使用手动指定主机/端口或广域 DNS-SD。

## 版本控制

桥接目前为**隐式 v1**（无最小/最大版本协商）。预期保持向后兼容；在引入任何破坏性变更之前应添加桥接协议版本字段。
