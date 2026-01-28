---
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
title: 出站会话镜像重构（Issue
x-i18n:
  generated_at: "2026-02-01T21:36:30Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b88a72f36f7b6d8a71fde9d014c0a87e9a8b8b0d449b67119cf3b6f414fa2b81
  source_path: refactor/outbound-session-mirroring.md
  workflow: 15
---

# 出站会话镜像重构（Issue #1520）

## 状态

- 进行中。
- 核心 + 插件渠道路由已针对出站镜像进行更新。
- Gateway网关发送现在在省略 sessionKey 时自动推导目标会话。

## 背景

出站发送过去被镜像到*当前*智能体会话（工具会话键）而非目标渠道会话。入站路由使用渠道/对端会话键，因此出站响应落入了错误的会话，且首次联系的目标通常缺少会话条目。

## 目标

- 将出站消息镜像到目标渠道会话键。
- 在缺少会话条目时，于出站时创建会话条目。
- 保持线程/话题作用域与入站会话键对齐。
- 覆盖核心渠道及捆绑扩展。

## 实现摘要

- 新增出站会话路由辅助模块：
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` 使用 `buildAgentSessionKey`（dmScope + identityLinks）构建目标 sessionKey。
  - `ensureOutboundSessionEntry` 通过 `recordSessionMetaFromInbound` 写入最小化的 `MsgContext`。
- `runMessageAction`（发送）推导目标 sessionKey 并传递给 `executeSendAction` 用于镜像。
- `message-tool` 不再直接镜像；它仅从当前会话键解析 agentId。
- 插件发送路径使用推导的 sessionKey 通过 `appendAssistantMessageToSessionTranscript` 进行镜像。
- Gateway网关发送在未提供 sessionKey 时推导目标会话键（默认智能体），并确保会话条目存在。

## 线程/话题处理

- Slack：replyTo/threadId -> `resolveThreadSessionKeys`（后缀）。
- Discord：threadId/replyTo -> `resolveThreadSessionKeys`，`useSuffix=false` 以匹配入站（线程频道 ID 已限定会话作用域）。
- Telegram：话题 ID 通过 `buildTelegramGroupPeerId` 映射为 `chatId:topic:<id>`。

## 已覆盖的扩展

- Matrix、MS Teams、Mattermost、BlueBubbles、Nextcloud Talk、Zalo、Zalo Personal、Nostr、Tlon。
- 备注：
  - Mattermost 目标现在为 私信 会话键路由去除 `@` 前缀。
  - Zalo Personal 对 1:1 目标使用 私信 对端类型（仅在存在 `group:` 时使用群组）。
  - BlueBubbles 群组目标去除 `chat_*` 前缀以匹配入站会话键。
  - Slack 自动线程镜像不区分频道 ID 大小写进行匹配。
  - Gateway网关发送在镜像前将提供的会话键转为小写。

## 决策

- **Gateway网关发送会话推导**：如果提供了 `sessionKey`，则直接使用。如果省略，则从目标 + 默认智能体推导 sessionKey 并镜像到该会话。
- **会话条目创建**：始终使用 `recordSessionMetaFromInbound`，其 `Provider/From/To/ChatType/AccountId/Originating*` 与入站格式对齐。
- **目标规范化**：出站路由在可用时使用已解析的目标（经过 `resolveChannelTarget` 处理后）。
- **会话键大小写**：在写入和迁移时将会话键规范化为小写。

## 新增/更新的测试

- `src/infra/outbound/outbound-session.test.ts`
  - Slack 线程会话键。
  - Telegram 话题会话键。
  - 使用 Discord 的 dmScope identityLinks。
- `src/agents/tools/message-tool.test.ts`
  - 从会话键推导 agentId（不传递 sessionKey）。
- `src/gateway/server-methods/send.test.ts`
  - 省略时推导会话键并创建会话条目。

## 待办事项 / 后续跟进

- 语音通话插件使用自定义 `voice:<phone>` 会话键。此处的出站映射尚未标准化；如果 message-tool 需要支持语音通话发送，需添加显式映射。
- 确认是否有外部插件使用超出捆绑集合的非标准 `From/To` 格式。

## 涉及的文件

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- 测试文件：
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
