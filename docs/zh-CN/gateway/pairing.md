---
read_when:
  - 在没有 macOS UI 的情况下实现节点配对审批
  - 添加用于审批远程节点的 CLI 流程
  - 扩展 Gateway网关协议以支持节点管理
summary: Gateway网关拥有的节点配对（方案 B），适用于 iOS 及其他远程节点
title: Gateway网关拥有的配对
x-i18n:
  generated_at: "2026-02-01T20:35:26Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 1f5154292a75ea2c1470324babc99c6c46a5e4e16afb394ed323d28f6168f459
  source_path: gateway/pairing.md
  workflow: 14
---

# Gateway网关拥有的配对（方案 B）

在 Gateway网关拥有的配对模式中，**Gateway网关** 是决定哪些节点允许加入的权威来源。UI（macOS 应用、未来的客户端）只是用于批准或拒绝待处理请求的前端。

**重要说明：**WS 节点在 `connect` 过程中使用**设备配对**（角色 `node`）。`node.pair.*` 是一个独立的配对存储，**不会**控制 WS 握手。只有显式调用 `node.pair.*` 的客户端才使用此流程。

## 概念

- **待处理请求**：节点请求加入，需要审批。
- **已配对节点**：已批准的节点，带有已签发的认证令牌。
- **传输层**：Gateway网关 WS 端点转发请求但不决定成员资格。（旧版 TCP 桥接支持已弃用/移除。）

## 配对工作原理

1. 节点连接到 Gateway网关 WS 并请求配对。
2. Gateway网关存储一个**待处理请求**并发出 `node.pair.requested` 事件。
3. 你批准或拒绝该请求（通过 CLI 或 UI）。
4. 批准后，Gateway网关签发一个**新令牌**（重新配对时令牌会轮换）。
5. 节点使用该令牌重新连接，此时即为"已配对"状态。

待处理请求会在 **5 分钟**后自动过期。

## CLI 工作流（适合无界面环境）

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status` 显示已配对/已连接的节点及其能力。

## API 接口（Gateway网关协议）

事件：

- `node.pair.requested` — 创建新的待处理请求时发出。
- `node.pair.resolved` — 请求被批准/拒绝/过期时发出。

方法：

- `node.pair.request` — 创建或复用待处理请求。
- `node.pair.list` — 列出待处理和已配对的节点。
- `node.pair.approve` — 批准待处理请求（签发令牌）。
- `node.pair.reject` — 拒绝待处理请求。
- `node.pair.verify` — 验证 `{ nodeId, token }`。

注意事项：

- `node.pair.request` 对每个节点是幂等的：重复调用返回相同的待处理请求。
- 批准操作**始终**生成新令牌；`node.pair.request` 不会返回任何令牌。
- 请求可包含 `silent: true` 作为自动批准流程的提示。

## 自动批准（macOS 应用）

macOS 应用可在以下条件满足时选择性地尝试**静默批准**：

- 请求标记为 `silent`，且
- 应用能够使用同一用户验证与 Gateway网关主机的 SSH 连接。

如果静默批准失败，则回退到常规的"批准/拒绝"提示。

## 存储（本地，私有）

配对状态存储在 Gateway网关状态目录下（默认 `~/.openclaw`）：

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

如果你覆盖了 `OPENCLAW_STATE_DIR`，`nodes/` 文件夹会随之移动。

安全注意事项：

- 令牌是机密信息；请将 `paired.json` 视为敏感文件。
- 轮换令牌需要重新审批（或删除节点条目）。

## 传输层行为

- 传输层是**无状态的**；它不存储成员信息。
- 如果 Gateway网关离线或配对功能被禁用，节点无法配对。
- 如果 Gateway网关处于远程模式，配对仍然基于远程 Gateway网关的存储进行。
