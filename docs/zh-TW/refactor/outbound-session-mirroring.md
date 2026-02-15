---
title: 出站工作階段鏡像重構 (Issue #1520)
description: 追蹤出站工作階段鏡像重構的筆記、決策、測試和待辦事項。
---

# 出站工作階段鏡像重構 (Issue #1520)

## 狀態

- 進行中。
- 核心與外掛程式頻道路由已針對出站鏡像進行更新。
- 當省略 sessionKey 時，Gateway send 現在會推導出目標工作階段。

## 背景

出站傳送先前被鏡像到目前智慧代理工作階段（工具工作階段鍵名），而非目標頻道工作階段。入站路由使用頻道/同儕工作階段鍵名，因此出站回應會進入錯誤的工作階段，且首次接觸的目標通常缺少工作階段條目。

## 目標

- 將出站訊息鏡像至目標頻道工作階段鍵名。
- 在出站時若缺少工作階段條目則予以建立。
- 保持執行緒/主題範圍與入站工作階段鍵名一致。
- 涵蓋核心頻道以及內建擴充功能。

## 實作摘要

- 新的出站工作階段路由輔助工具：
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` 使用 `buildAgentSessionKey` (dmScope + identityLinks) 建立目標 sessionKey。
  - `ensureOutboundSessionEntry` 透過 `recordSessionMetaFromInbound` 寫入最小的 `MsgContext`。
- `runMessageAction` (send) 推導出目標 sessionKey，並將其傳遞給 `executeSendAction` 進行鏡像。
- `message-tool` 不再直接鏡像；它僅從目前的工作階段鍵名中解析 agentId。
- 外掛程式傳送路徑使用推導出的 sessionKey 透過 `appendAssistantMessageToSessionTranscript` 進行鏡像。
- Gateway send 當未提供時（預設智慧代理）會推導出目標工作階段鍵名，並確保工作階段條目存在。

## 執行緒/主題處理

- Slack：replyTo/threadId -> `resolveThreadSessionKeys` (後綴)。
- Discord：threadId/replyTo -> 使用 `useSuffix=false` 的 `resolveThreadSessionKeys` 以匹配入站（執行緒頻道 ID 已界定工作階段範圍）。
- Telegram：主題 ID 透過 `buildTelegramGroupPeerId` 對應至 `chatId:topic:<id>`。

## 涵蓋的擴充功能

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon。
- 附註：
  - Mattermost 目標現在會移除 `@` 以進行私訊工作階段鍵名路由。
  - Zalo Personal 對於 1:1 目標使用私訊同儕類型（僅在存在 `group:` 時使用群組）。
  - BlueBubbles 群組目標會移除 `chat_*` 前綴以匹配入站工作階段鍵名。
  - Slack 自動執行緒鏡像匹配頻道 ID 時不區分大小寫。
  - Gateway send 在鏡像前會將提供的工作階段鍵名轉換為小寫。

## 決策

- **Gateway send 工作階段推導**：如果提供了 `sessionKey`，則使用它。如果省略，則從目標 + 預設智慧代理推導出 sessionKey 並在該處鏡像。
- **工作階段條目建立**：始終使用 `recordSessionMetaFromInbound`，並讓 `Provider/From/To/ChatType/AccountId/Originating*` 與入站格式保持一致。
- **目標正規化**：出站路由在可用時使用解析後的目標（經由 `resolveChannelTarget` 處理後）。
- **工作階段鍵名大小寫**：在寫入和遷移期間將工作階段鍵名規範化為小寫。

## 新增/更新的測試

- `src/infra/outbound/outbound-session.test.ts`
  - Slack 執行緒工作階段鍵名。
  - Telegram 主題工作階段鍵名。
  - Discord 的 dmScope identityLinks。
- `src/agents/tools/message-tool.test.ts`
  - 從工作階段鍵名推導 agentId（未傳遞 sessionKey）。
- `src/gateway/server-methods/send.test.ts`
  - 省略時推導工作階段鍵名並建立工作階段條目。

## 待辦事項 / 後續行動

- Voice-call 外掛程式使用自定義的 `voice:<phone>` 工作階段鍵名。此處的出站映射尚未標準化；如果 message-tool 應支援 voice-call 傳送，請新增明確的映射。
- 確認是否有任何外部外掛程式使用了超出內建集合之外的非標準 `From/To` 格式。

## 涉及的檔案

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- 測試檔案：
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
