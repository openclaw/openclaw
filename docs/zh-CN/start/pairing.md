---
read_when:
  - 设置私信访问控制时
  - 配对新的 iOS/Android 节点时
  - 审查 OpenClaw 安全态势时
summary: 配对概览：审批谁可以私信你 + 哪些节点可以加入
title: 配对
x-i18n:
  generated_at: "2026-02-01T21:38:45Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: c46a5c39f289c8fd0783baacd927f550c3d3ae8889a7bc7de133b795f16fa08a
  source_path: start/pairing.md
  workflow: 15
---

# 配对

"配对"是 OpenClaw 的显式**所有者审批**步骤。
它用于两个场景：

1. **私信配对**（谁被允许与机器人对话）
2. **节点配对**（哪些设备/节点被允许加入 Gateway网关网络）

安全上下文：[安全](/gateway/security)

## 1) 私信配对（入站聊天访问）

当渠道配置了私信策略 `pairing` 时，未知发送者会收到一个短码，其消息在你批准之前**不会被处理**。

默认私信策略记录在：[安全](/gateway/security)

配对码：

- 8 个字符，大写，不含歧义字符（`0O1I`）。
- **1 小时后过期**。机器人仅在创建新请求时发送配对消息（每个发送者大约每小时一次）。
- 待处理的私信配对请求默认每个渠道上限为 **3 个**；额外请求将被忽略，直到有请求过期或被批准。

### 批准发送者

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

支持的渠道：`telegram`、`whatsapp`、`signal`、`imessage`、`discord`、`slack`。

### 状态存储位置

存储在 `~/.openclaw/credentials/` 下：

- 待处理请求：`<channel>-pairing.json`
- 已批准的允许列表存储：`<channel>-allowFrom.json`

请将这些文件视为敏感信息（它们控制着对你助手的访问权限）。

## 2) 节点设备配对（iOS/Android/macOS/无头节点）

节点以 `role: node` 的**设备**身份连接到 Gateway网关。Gateway网关会创建一个需要批准的设备配对请求。

### 批准节点设备

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### 状态存储位置

存储在 `~/.openclaw/devices/` 下：

- `pending.json`（短期有效；待处理请求会过期）
- `paired.json`（已配对设备 + 令牌）

### 注意事项

- 旧版 `node.pair.*` API（CLI：`openclaw nodes pending/approve`）是一个独立的 Gateway网关所拥有的配对存储。WebSocket 节点仍然需要设备配对。

## 相关文档

- 安全模型 + 提示注入：[安全](/gateway/security)
- 安全更新（运行 doctor）：[更新](/install/updating)
- 渠道配置：
  - Telegram：[Telegram](/channels/telegram)
  - WhatsApp：[WhatsApp](/channels/whatsapp)
  - Signal：[Signal](/channels/signal)
  - iMessage：[iMessage](/channels/imessage)
  - Discord：[Discord](/channels/discord)
  - Slack：[Slack](/channels/slack)
