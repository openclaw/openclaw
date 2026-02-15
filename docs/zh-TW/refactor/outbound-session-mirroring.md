---
title: 出站工作階段鏡像重構 (Issue #1520)
description: 追蹤出站工作階段鏡像重構的筆記、決策、測試和未竟項目。
---

# 出站工作階段鏡像重構 (Issue #1520)

## 狀態

- 進行中。
- 核心 + 插件頻道路由已更新以支援出站鏡像。
- 當 `sessionKey` 被省略時，Gateway 發送現在會衍生目標工作階段。

## 背景

出站發送被鏡像到_當前_智慧代理工作階段（工具工作階段鍵名），而不是目標頻道工作階段。入站路由使用頻道/對等工作階段鍵名，因此出站回應落入錯誤的工作階段，且首次接觸的目標通常缺少工作階段條目。

## 目標

- 將出站訊息鏡像到目標頻道工作階段鍵名。
- 當缺少時，在出站時建立工作階段條目。
- 保持線程/主題範圍與入站工作階段鍵名對齊。
- 涵蓋核心頻道及捆綁擴充功能。

## 實作摘要

- 新的出站工作階段路由輔助程式：
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` 使用 `buildAgentSessionKey` (dmScope + identityLinks) 建立目標 sessionKey。
  - `ensureOutboundSessionEntry` 透過 `recordSessionMetaFromInbound` 寫入最小的 `MsgContext`。
- `runMessageAction`（發送）衍生目標 sessionKey 並將其傳遞給 `executeSendAction` 進行鏡像。
- `message-tool` 不再直接鏡像；它只從當前工作階段鍵名解析 `agentId`。
- 插件發送路徑透過 `appendAssistantMessageToSessionTranscript` 使用衍生的 `sessionKey` 進行鏡像。
- 當未提供 `sessionKey` 時（預設智慧代理），Gateway 發送會衍生一個目標工作階段鍵名，並確保工作階段條目存在。

## 線程/主題處理

- Slack：`replyTo`/`threadId` -> `resolveThreadSessionKeys`（後綴）。
- Discord：`threadId`/`replyTo` -> `resolveThreadSessionKeys`，其中 `useSuffix=false` 以符合入站（線程頻道 ID 已限定工作階段範圍）。
- Telegram：主題 ID 透過 `buildTelegramGroupPeerId` 映射到 `chatId:topic:<id>`。

## 涵蓋的擴充功能

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon.
- 注意事項：
  - Mattermost 目標現在會剝離 ` @` 以進行私訊工作階段鍵名路由。
  - Zalo Personal 對於 1:1 目標使用私訊對等類型（只有在 `group:` 存在時才為群組）。
  - BlueBubbles 群組目標會剝離 `chat_*` 前綴以符合入站工作階段鍵名。
  - Slack 自動線程鏡像會不區分大小寫地匹配頻道 ID。
  - Gateway 發送會在鏡像之前將提供的 session keys 轉換為小寫。

## 決策

- **Gateway 發送工作階段衍生**：如果提供了 `sessionKey`，則使用它。如果省略，則從目標 + 預設智慧代理衍生一個 `sessionKey` 並鏡像到該處。
- **工作階段條目建立**：始終使用 `recordSessionMetaFromInbound`，並讓 `Provider/From/To/ChatType/AccountId/Originating*` 與入站格式對齊。
- **目標正規化**：出站路由在可用時使用已解析的目標（`resolveChannelTarget` 之後）。
- **工作階段鍵名大小寫**：在寫入和遷移期間將工作階段鍵名規範化為小寫。

## 已新增/更新的測試

- `src/infra/outbound/outbound-session.test.ts`
  - Slack 線程工作階段鍵名。
  - Telegram 主題工作階段鍵名。
  - 帶有 Discord 的 dmScope identityLinks。
- `src/agents/tools/message-tool.test.ts`
  - 從工作階段鍵名衍生 `agentId`（沒有 `sessionKey` 傳遞）。
- `src/gateway/server-methods/send.test.ts`
  - 當省略時衍生工作階段鍵名並建立工作階段條目。

## 未竟項目 / 後續追蹤

- 語音通話插件使用自訂的 `voice:<phone>` 工作階段鍵名。此處的出站映射尚未標準化；如果 `message-tool` 應支援語音通話發送，則新增明確映射。
- 確認是否有任何外部插件使用超出捆綁集之外的非標準 `From/To` 格式。

## 已觸及的檔案

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- Tests in:
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
