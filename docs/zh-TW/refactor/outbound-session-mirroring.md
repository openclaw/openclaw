---
title: refactor/outbound-session-mirroring.md #1520)
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
---

# Outbound Session Mirroring Refactor (Issue #1520)

## Status

- 進行中。
- Core + plugin channel routing updated for outbound mirroring.
- Gateway send 現在會在省略 sessionKey 時推導目標工作階段。

## Context

Outbound sends were mirrored into the _current_ agent session (tool session key) rather than the target channel session. Inbound routing uses channel/peer session keys, so outbound responses landed in the wrong session and first-contact targets often lacked session entries.

## 目標

- Mirror outbound messages into the target channel session key.
- Create session entries on outbound when missing.
- Keep thread/topic scoping aligned with inbound session keys.
- Cover core channels plus bundled extensions.

## 實作摘要

- 新的外送工作階段路由輔助工具：
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` 會使用 `buildAgentSessionKey`（dmScope + identityLinks）建立目標 sessionKey。
  - `ensureOutboundSessionEntry` 會透過 `recordSessionMetaFromInbound` 寫入最小的 `MsgContext`。
- `runMessageAction`（send）會推導目標 sessionKey，並將其傳遞給 `executeSendAction` 以進行鏡像。
- `message-tool` 不再直接鏡像；它僅從目前的工作階段金鑰解析 agentId。
- 外掛的 send 路徑會使用推導出的 sessionKey，透過 `appendAssistantMessageToSessionTranscript` 進行鏡像。
- Gateway send derives a target session key when none is provided (default agent), and ensures a session entry.

## Thread/Topic Handling

- Slack：replyTo/threadId -> `resolveThreadSessionKeys`（後綴）。
- Discord：threadId/replyTo -> `resolveThreadSessionKeys`，並使用 `useSuffix=false` 以符合入站（執行緒頻道 id 已界定工作階段）。
- Telegram：主題 ID 透過 `buildTelegramGroupPeerId` 對應到 `chatId:topic:<id>`。

## 涵蓋的擴充套件

- Matrix、MS Teams、Mattermost、BlueBubbles、Nextcloud Talk、Zalo、Zalo Personal、Nostr、Tlon。
- 注意事項：
  - Mattermost 目標現在會移除 `@`，以用於 DM 工作階段金鑰路由。
  - Zalo Personal 對 1:1 目標使用 DM 對等端種類（僅在存在 `group:` 時才使用群組）。
  - BlueBubbles 群組目標會移除 `chat_*` 前綴，以符合入站工作階段金鑰。
  - Slack 自動執行緒鏡像會以不區分大小寫的方式比對頻道 id。
  - Gateway send lowercases provided session keys before mirroring.

## 決策

- **Gateway send 工作階段推導**：若提供 `sessionKey`，則使用它；若省略，則從目標 + 預設代理推導 sessionKey 並在該處鏡像。 If omitted, derive a sessionKey from target + default agent and mirror there.
- **工作階段項目建立**：一律使用 `recordSessionMetaFromInbound`，且 `Provider/From/To/ChatType/AccountId/Originating*` 與入站格式對齊。
- **目標正規化**：外送路由在可用時使用已解析的目標（`resolveChannelTarget` 之後）。
- **Session key casing**: canonicalize session keys to lowercase on write and during migrations.

## 新增／更新的測試

- `src/infra/outbound/outbound-session.test.ts`
  - Slack thread session key.
  - Telegram topic session key.
  - 使用 Discord 的 dmScope identityLinks。
- `src/agents/tools/message-tool.test.ts`
  - 從工作階段金鑰推導 agentId（未傳遞 sessionKey）。
- `src/gateway/server-methods/send.test.ts`
  - Derives session key when omitted and creates session entry.

## 開放項目／後續事項

- Voice-call plugin uses custom `voice:<phone>` session keys. Outbound mapping is not standardized here; if message-tool should support voice-call sends, add explicit mapping.
- 確認是否有任何外部外掛使用超出隨附集合之外的非標準 `From/To` 格式。

## Files Touched

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- 測試位於：
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
