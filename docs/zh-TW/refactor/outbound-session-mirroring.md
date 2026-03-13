---
title: Outbound Session Mirroring Refactor (Issue
description: >-
  Track outbound session mirroring refactor notes, decisions, tests, and open
  items.
summary: Refactor notes for mirroring outbound sends into target channel sessions
read_when:
  - Working on outbound transcript/session mirroring behavior
  - Debugging sessionKey derivation for send/message tool paths
---

# 出站會話鏡像重構（Issue #1520）

## 狀態

- 進行中。
- 核心與插件頻道路由已更新以支援出站鏡像。
- Gateway 傳送時若省略 sessionKey，會自動推導目標會話。

## 背景

出站傳送訊息會鏡像到 _目前_ 的代理會話（工具會話金鑰），而非目標頻道會話。入站路由使用頻道/對等會話金鑰，因此出站回應會落在錯誤的會話中，且首次聯絡目標常缺少會話條目。

## 目標

- 將出站訊息鏡像到目標頻道會話金鑰。
- 出站時若缺少會話條目，則建立。
- 保持執行緒/主題範圍與入站會話金鑰一致。
- 支援核心頻道及綁定的擴充套件。

## 實作摘要

- 新增出站會話路由輔助函式：
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` 使用 `buildAgentSessionKey`（dmScope + identityLinks）建立目標 sessionKey。
  - `ensureOutboundSessionEntry` 透過 `recordSessionMetaFromInbound` 寫入最小化的 `MsgContext`。
- `runMessageAction`（send）推導目標 sessionKey 並傳給 `executeSendAction` 進行鏡像。
- `message-tool` 不再直接鏡像；僅從目前 sessionKey 解析 agentId。
- 插件傳送路徑透過 `appendAssistantMessageToSessionTranscript` 使用推導的 sessionKey 進行鏡像。
- Gateway 傳送若未提供 sessionKey，會推導目標 sessionKey（預設代理），並確保會話條目存在。

## 執行緒/主題處理

- Slack：replyTo/threadId -> `resolveThreadSessionKeys`（後綴）。
- Discord：threadId/replyTo -> `resolveThreadSessionKeys` 搭配 `useSuffix=false`，與入站匹配（執行緒頻道 ID 已範圍會話）。
- Telegram：主題 ID 透過 `buildTelegramGroupPeerId` 映射到 `chatId:topic:<id>`。

## 涵蓋的擴充套件

- Matrix、MS Teams、Mattermost、BlueBubbles、Nextcloud Talk、Zalo、Zalo Personal、Nostr、Tlon。
- 備註：
  - Mattermost 目標現在會剝除 `@` 以利 DM 會話金鑰路由。
  - Zalo Personal 對 1:1 目標使用 DM 對等類型（只有在 `group:` 存在時才為群組）。
  - BlueBubbles 群組目標會剝除 `chat_*` 前綴以符合入站會話金鑰。
  - Slack 自動執行緒鏡像以不區分大小寫匹配頻道 ID。
  - Gateway 傳送時會將提供的 sessionKey 轉為小寫後再鏡像。

## 決策

- **Gateway 傳送會話推導**：若提供 `sessionKey`，則使用；若省略，則從目標 + 預設代理推導 sessionKey 並鏡像至該處。
- **會話條目建立**：始終使用 `recordSessionMetaFromInbound` 並與入站格式 `Provider/From/To/ChatType/AccountId/Originating*` 對齊。
- **目標正規化**：出站路由使用解析後的目標（經 `resolveChannelTarget` 處理）若可用。
- **會話金鑰大小寫**：寫入及遷移時皆將會話金鑰標準化為小寫。

## 新增/更新的測試

- `src/infra/outbound/outbound.test.ts`
  - Slack 討論串會話金鑰。
  - Telegram 主題會話金鑰。
  - 與 Discord 的 dmScope identityLinks。
- `src/agents/tools/message-tool.test.ts`
  - 從會話金鑰推導 agentId（未傳入 sessionKey）。
- `src/gateway/server-methods/send.test.ts`
  - 當省略會話金鑰時推導並建立會話條目。

## 待處理事項 / 後續追蹤

- 語音通話插件使用自訂的 `voice:<phone>` 會話金鑰。此處未標準化外發映射；若 message-tool 需支援語音通話發送，請新增明確映射。
- 確認是否有任何外部插件使用超出內建集合的非標準 `From/To` 格式。

## 變更檔案

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- 測試檔案：
  - `src/infra/outbound/outbound.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
