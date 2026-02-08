---
title: 外送工作階段鏡像重構（Issue #1520）
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
x-i18n:
  source_path: refactor/outbound-session-mirroring.md
  source_hash: b88a72f36f7b6d8a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:29:09Z
---

# 外送工作階段鏡像重構（Issue #1520）

## 狀態

- 進行中。
- 已更新核心與外掛的頻道路由以支援外送鏡像。
- Gateway send 現在會在省略 sessionKey 時推導目標工作階段。

## 背景

外送傳送先前被鏡像到「目前」的代理工作階段（工具工作階段金鑰），而非目標頻道的工作階段。入站路由使用頻道／對等端的工作階段金鑰，因此外送回應會落在錯誤的工作階段，且首次聯絡的目標經常缺少工作階段項目。

## 目標

- 將外送訊息鏡像到目標頻道的工作階段金鑰。
- 在外送時缺少工作階段則建立工作階段項目。
- 讓執行緒／主題的範圍界定與入站工作階段金鑰保持一致。
- 涵蓋核心頻道與隨附的擴充套件。

## 實作摘要

- 新的外送工作階段路由輔助工具：
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` 會使用 `buildAgentSessionKey`（dmScope + identityLinks）建立目標 sessionKey。
  - `ensureOutboundSessionEntry` 會透過 `recordSessionMetaFromInbound` 寫入最小的 `MsgContext`。
- `runMessageAction`（send）會推導目標 sessionKey，並將其傳遞給 `executeSendAction` 以進行鏡像。
- `message-tool` 不再直接鏡像；它僅從目前的工作階段金鑰解析 agentId。
- 外掛的 send 路徑會使用推導出的 sessionKey，透過 `appendAssistantMessageToSessionTranscript` 進行鏡像。
- Gateway send 在未提供任何值時會推導目標工作階段金鑰（預設代理），並確保建立工作階段項目。

## 執行緒／主題處理

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
  - Gateway send 在鏡像前會將提供的工作階段金鑰轉為小寫。

## 決策

- **Gateway send 工作階段推導**：若提供 `sessionKey`，則使用它；若省略，則從目標 + 預設代理推導 sessionKey 並在該處鏡像。
- **工作階段項目建立**：一律使用 `recordSessionMetaFromInbound`，且 `Provider/From/To/ChatType/AccountId/Originating*` 與入站格式對齊。
- **目標正規化**：外送路由在可用時使用已解析的目標（`resolveChannelTarget` 之後）。
- **工作階段金鑰大小寫**：在寫入與遷移期間，將工作階段金鑰正規化為小寫。

## 新增／更新的測試

- `src/infra/outbound/outbound-session.test.ts`
  - Slack 執行緒工作階段金鑰。
  - Telegram 主題工作階段金鑰。
  - 使用 Discord 的 dmScope identityLinks。
- `src/agents/tools/message-tool.test.ts`
  - 從工作階段金鑰推導 agentId（未傳遞 sessionKey）。
- `src/gateway/server-methods/send.test.ts`
  - 在省略時推導工作階段金鑰並建立工作階段項目。

## 開放項目／後續事項

- 語音通話外掛使用自訂的 `voice:<phone>` 工作階段金鑰。此處的外送對應尚未標準化；若 message-tool 需要支援語音通話外送，請加入明確的對應。
- 確認是否有任何外部外掛使用超出隨附集合之外的非標準 `From/To` 格式。

## 變更的檔案

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- 測試位於：
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
