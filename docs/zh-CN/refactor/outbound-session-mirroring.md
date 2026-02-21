---
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
title: 出站会话镜像重构（Issue
x-i18n:
  generated_at: "2026-02-03T07:53:51Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b88a72f36f7b6d8a71fde9d014c0a87e9a8b8b0d449b67119cf3b6f414fa2b81
  source_path: refactor/outbound-session-mirroring.md
  workflow: 15
---

# 出站会话镜像重构（Issue #1520）

## 状态

- 进行中。
- 核心 + 插件渠道路由已更新以支持出站镜像。
- Gateway 网关发送现在在省略 sessionKey 时派生目标会话。

## 背景

出站发送被镜像到*当前*智能体会话（工具会话键）而不是目标渠道会话。入站路由使用渠道/对等方会话键，因此出站响应落在错误的会话中，首次联系的目标通常缺少会话条目。

## 目标

- 将出站消息镜像到目标渠道会话键。
- 在缺失时为出站创建会话条目。
- 保持线程/话题作用域与入站会话键对齐。
- 涵盖核心渠道加内置扩展。

## 实现摘要

- 新的出站会话路由辅助器：
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` 使用 `buildAgentSessionKey`（dmScope + identityLinks）构建目标 sessionKey。
  - `ensureOutboundSessionEntry` 通过 `recordSessionMetaFromInbound` 写入最小的 `MsgContext`。
- `runMessageAction`（发送）派生目标 sessionKey 并将其传递给 `executeSendAction` 进行镜像。
- `message-tool` 不再直接镜像；它只从当前会话键解析 agentId。
- 插件发送路径使用派生的 sessionKey 通过 `appendAssistantMessageToSessionTranscript` 进行镜像。
- Gateway 网关发送在未提供时派生目标会话键（默认智能体），并确保会话条目。

## 线程/话题处理

- Slack：replyTo/threadId -> `resolveThreadSessionKeys`（后缀）。
- Discord：threadId/replyTo -> `resolveThreadSessionKeys`，`useSuffix=false` 以匹配入站（线程频道 id 已经作用域会话）。
- Telegram：话题 ID 通过 `buildTelegramGroupPeerId` 映射到 `chatId:topic:<id>`。

## 涵盖的扩展

- Matrix、MS Teams、Mattermost、BlueBubbles、Nextcloud Talk、Zalo、Zalo Personal、Nostr、Tlon。
- 注意：
  - Mattermost 目标现在为私信会话键路由去除 `@`。
  - Zalo Personal 对 1:1 目标使用私信对等方类型（仅当存在 `group:` 时才使用群组）。
  - BlueBubbles 群组目标去除 `chat_*` 前缀以匹配入站会话键。
  - Slack 自动线程镜像不区分大小写地匹配频道 id。
  - Gateway 网关发送在镜像前将提供的会话键转换为小写。

## 决策

- **Gateway 网关发送会话派生**：如果提供了 `sessionKey`，则使用它。如果省略，从目标 + 默认智能体派生 sessionKey 并镜像到那里。
- **会话条目创建**：始终使用 `recordSessionMetaFromInbound`，`Provider/From/To/ChatType/AccountId/Originating*` 与入站格式对齐。
- **目标规范化**：出站路由在可用时使用解析后的目标（`resolveChannelTarget` 之后）。
- **会话键大小写**：在写入和迁移期间将会话键规范化为小写。

## 添加/更新的测试

- `src/infra/outbound/outbound-session.test.ts`
  - Slack 线程会话键。
  - Telegram 话题会话键。
  - dmScope identityLinks 与 Discord。
- `src/agents/tools/message-tool.test.ts`
  - 从会话键派生 agentId（不传递 sessionKey）。
- `src/gateway/server-methods/send.test.ts`
  - 在省略时派生会话键并创建会话条目。

## 待处理项目 / 后续跟进

- 语音通话插件使用自定义的 `voice:<phone>` 会话键。出站映射在这里没有标准化；如果 message-tool 应该支持语音通话发送，请添加显式映射。
- 确认是否有任何外部插件使用内置集之外的非标准 `From/To` 格式。

## 涉及的文件

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- 测试：
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
