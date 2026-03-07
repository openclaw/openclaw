---
read_when:
  - 在没有 macOS UI 的情况下实现节点配对审批
  - 添加用于审批远程节点的 CLI 流程
  - 扩展 Gateway 网关协议以支持节点管理
summary: Gateway 网关拥有的节点配对（选项 B），用于 iOS 和其他远程节点
title: Gateway 网关拥有的配对
x-i18n:
  generated_at: "2026-02-03T07:48:32Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 1f5154292a75ea2c1470324babc99c6c46a5e4e16afb394ed323d28f6168f459
  source_path: gateway/pairing.md
  workflow: 15
---

# Gateway 网关拥有的配对（选项 B）

在 Gateway 网关拥有的配对中，**Gateway 网关**是允许哪些节点加入的唯一信息源。UI（macOS 应用、未来的客户端）只是审批或拒绝待处理请求的前端。

**重要：**WS 节点在 `connect` 期间使用**设备配对**（角色 `node`）。`node.pair.*` 是一个独立的配对存储，**不会**限制 WS 握手。只有显式调用 `node.pair.*` 的客户端使用此流程。

## 概念

- **待处理请求**：一个节点请求加入；需要审批。
- **已配对节点**：已批准的节点，带有已颁发的认证令牌。
- **传输层**：Gateway 网关 WS 端点转发请求但不决定成员资格。（旧版 TCP 桥接支持已弃用/移除。）

## 配对工作原理

1. 节点连接到 Gateway 网关 WS 并请求配对。
2. Gateway 网关存储一个**待处理请求**并发出 `node.pair.requested`。
3. 你审批或拒绝该请求（CLI 或 UI）。
4. 审批后，Gateway 网关颁发一个**新令牌**（重新配对时令牌会轮换）。
5. 节点使用该令牌重新连接，现在是"已配对"状态。

待处理请求在 **5 分钟**后自动过期。

## CLI 工作流程（支持无头模式）

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status` 显示已配对/已连接的节点及其功能。

## API 接口（Gateway 网关协议）

事件：

- `node.pair.requested` — 创建新的待处理请求时发出。
- `node.pair.resolved` — 请求被批准/拒绝/过期时发出。

方法：

- `node.pair.request` — 创建或复用待处理请求。
- `node.pair.list` — 列出待处理 + 已配对的节点。
- `node.pair.approve` — 批准待处理请求（颁发令牌）。
- `node.pair.reject` — 拒绝待处理请求。
- `node.pair.verify` — 验证 `{ nodeId, token }`。

注意事项：

- `node.pair.request` 对每个节点是幂等的：重复调用返回相同的待处理请求。
- 审批**总是**生成新的令牌；`node.pair.request` 永远不会返回令牌。
- 请求可以包含 `silent: true` 作为自动审批流程的提示。

## 自动审批（macOS 应用）

当满足以下条件时，macOS 应用可以选择尝试**静默审批**：

- 请求标记为 `silent`，且
- 应用可以使用相同用户验证到 Gateway 网关主机的 SSH 连接。

如果静默审批失败，则回退到正常的"批准/拒绝"提示。

## 存储（本地，私有）

配对状态存储在 Gateway 网关状态目录下（默认 `~/.openclaw`）：

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

如果你覆盖了 `OPENCLAW_STATE_DIR`，`nodes/` 文件夹会随之移动。

安全注意事项：

- 令牌是机密信息；将 `paired.json` 视为敏感文件。
- 轮换令牌需要重新审批（或删除节点条目）。

## 传输层行为

- 传输层是**无状态的**；它不存储成员资格。
- 如果 Gateway 网关离线或配对被禁用，节点无法配对。
- 如果 Gateway 网关处于远程模式，配对仍然针对远程 Gateway 网关的存储进行。
