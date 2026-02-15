---
summary: "透過 grammY 整合 Telegram Bot API 與設定注意事項"
read_when:
  - 處理 Telegram 或 grammY 相關流程時閱讀
title: grammY
---

# grammY 整合 (Telegram Bot API)

# 為何選擇 grammY

- TS 優先的 Bot API 客戶端，內建 long-poll + webhook 輔助程式、中介軟體、錯誤處理、流量限制器。
- 媒體輔助程式比手動實作 fetch + FormData 更簡潔；支援所有 Bot API 方法。
- 可擴充：透過自訂 fetch 支援代理、工作階段 中介軟體 (可選)、型別安全的內容。

# 已發布功能

- **單一客戶端路徑：**基於 fetch 的實作已移除；grammY 現為唯一的 Telegram 客戶端 (傳送 + Gateway)，預設啟用 grammY 節流器。
- **Gateway：** `monitorTelegramProvider` 建立 grammY `Bot`，連接提及/允許清單閘控、透過 `getFile`/`download` 下載媒體，並透過 `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument` 傳送回覆。透過 `webhookCallback` 支援 long-poll 或 webhook。
- **代理：**可選的 `channels.telegram.proxy` 透過 grammY 的 `client.baseFetch` 使用 `undici.ProxyAgent`。
- **Webhook 支援：** `webhook-set.ts` 封裝 `setWebhook/deleteWebhook`；`webhook.ts` 託管回呼，並提供健康檢查 + 優雅關機。當 `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` 設定時，Gateway 啟用 webhook 模式 (否則為 long-poll)。
- **工作階段：**直接聊天會歸併到 智慧代理 主要 工作階段 (`agent:<agentId>:<mainKey>`)；群組使用 `agent:<agentId>:telegram:group:<chatId>`)；回覆會路由回同一個 頻道。
- **設定旋鈕：** `channels.telegram.botToken`、`channels.telegram.dmPolicy`、`channels.telegram.groups` (允許清單 + 提及 預設)、`channels.telegram.allowFrom`、`channels.telegram.groupAllowFrom`、`channels.telegram.groupPolicy`、`channels.telegram.mediaMaxMb`、`channels.telegram.linkPreview`、`channels.telegram.proxy`、`channels.telegram.webhookSecret`、`channels.telegram.webhookUrl`、`channels.telegram.webhookHost`。
- **草稿串流傳輸：**可選的 `channels.telegram.streamMode` 在私人主題聊天中使用 `sendMessageDraft` (Bot API 9.3+)。這與頻道 區塊串流傳輸 是分開的。
- **測試：** grammY 模擬涵蓋 私訊 + 群組提及閘控和出站傳送；歡迎更多媒體/webhook 夾具。

待解決問題

- 如果我們遇到 Bot API 429 錯誤，可選的 grammY 外掛 (throttler)。
- 新增更多結構化的媒體測試 (貼圖、語音訊息)。
- 讓 webhook 監聽埠號可 設定 (目前固定為 8787，除非透過 Gateway 連接)。
