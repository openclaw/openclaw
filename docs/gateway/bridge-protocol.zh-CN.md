---
summary: "历史桥接协议（传统节点）：TCP JSONL、配对和作用域 RPC"
read_when:
  - 构建或调试节点客户端（iOS/Android/macOS 节点模式）
  - 调查配对或桥接身份验证失败
  - 审计网关公开的节点表面
title: "桥接协议"
---

# 桥接协议（传统节点传输）

<Warning>
TCP 桥接已被**移除**。当前的 OpenClaw 构建不包含桥接监听器，`bridge.*` 配置键不再存在于架构中。此页面仅作为历史参考保留。所有节点/操作员客户端请使用 [网关协议](/gateway/protocol)。
</Warning>

## 它存在的原因

- **安全边界**：桥接暴露一个小的允许列表，而不是完整的网关 API 表面。
- **配对 + 节点身份**：节点准入由网关拥有，并绑定到每个节点的令牌。
- **发现用户体验**：节点可以通过局域网中的 Bonjour 发现网关，或通过 tailnet 直接连接。
- **环回 WS**：完整的 WS 控制平面保持本地，除非通过 SSH 隧道。

## 传输

- TCP，每行一个 JSON 对象（JSONL）。
- 可选 TLS（当 `bridge.tls.enabled` 为 true 时）。
- 历史默认监听器端口为 `18790`（当前构建不启动 TCP 桥接）。

当启用 TLS 时，发现 TXT 记录包括 `bridgeTls=1` 以及作为非秘密提示的 `bridgeTlsSha256`。请注意，Bonjour/mDNS TXT 记录是未经验证的；客户端不得将广告的指纹视为权威固定，除非有明确的用户意图或其他带外验证。

## 握手 + 配对

1. 客户端发送带有节点元数据 + 令牌的 `hello`（如果已配对）。
2. 如果未配对，网关回复 `error`（`NOT_PAIRED`/`UNAUTHORIZED`）。
3. 客户端发送 `pair-request`。
4. 网关等待批准，然后发送 `pair-ok` 和 `hello-ok`。

历史上，`hello-ok` 返回 `serverName` 并可能包含 `canvasHostUrl`。

## 帧

客户端 → 网关：

- `req` / `res`：作用域网关 RPC（聊天、会话、配置、健康、语音唤醒、skills.bins）
- `event`：节点信号（语音转录、代理请求、聊天订阅、执行生命周期）

网关 → 客户端：

- `invoke` / `invoke-res`：节点命令（`canvas.*`、`camera.*`、`screen.record`、`location.get`、`sms.send`）
- `event`：已订阅会话的聊天更新
- `ping` / `pong`：保持活动

传统允许列表强制执行存在于 `src/gateway/server-bridge.ts` 中（已移除）。

## 执行生命周期事件

节点可以发出 `exec.finished` 或 `exec.denied` 事件来显示 system.run 活动。这些在网关中映射到系统事件。（传统节点可能仍然发出 `exec.started`。）

有效负载字段（除非另有说明，否则均为可选）：

- `sessionKey`（必需）：接收系统事件的代理会话。
- `runId`：用于分组的唯一执行 ID。
- `command`：原始或格式化的命令字符串。
- `exitCode`、`timedOut`、`success`、`output`：完成详细信息（仅完成）。
- `reason`：拒绝原因（仅拒绝）。

## 历史 tailnet 使用

- 将桥接绑定到 tailnet IP：在 `~/.openclaw/openclaw.json` 中设置 `bridge.bind: "tailnet"`（仅历史；`bridge.*` 不再有效）。
- 客户端通过 MagicDNS 名称或 tailnet IP 连接。
- Bonjour **不**跨网络；必要时使用手动主机/端口或广域 DNS‑SD。

## 版本控制

桥接是**隐式 v1**（无最小/最大协商）。本节仅作为历史参考；当前节点/操作员客户端使用 WebSocket [网关协议](/gateway/protocol)。
