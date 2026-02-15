---
summary: "透過 grammY 整合 Telegram Bot API 與設定說明"
read_when:
  - 處理 Telegram 或 grammY 途徑時
title: grammY
---

# grammY 整合 (Telegram Bot API)

# 為什麼選擇 grammY

- TS 優先的 Bot API 用戶端，內建 long-poll + webhook 輔助程式、中介軟體 (middleware)、錯誤處理、速率限制器 (rate limiter)。
- 比起手寫 fetch + FormData 具備更簡潔的媒體輔助程式；支援所有 Bot API 方法。
- 可擴充性：透過自訂 fetch 支援代理 (proxy)、選配的工作階段 (session) 中介軟體、以及型別安全的 context。

# 我們交付的內容

- **單一用戶端路徑：** 移除基於 fetch 的實作；grammY 現在是唯一的 Telegram 用戶端 (發送 + Gateway)，且預設啟用 grammY 節流器 (throttler)。
- **Gateway：** `monitorTelegramProvider` 建立 grammY `Bot`、處理標記 (mention)/允許清單 (allowlist) 門控 (gating)、透過 `getFile`/`download` 下載媒體，並使用 `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument` 傳送回覆。支援透過 `webhookCallback` 進行 long-poll 或 webhook。
- **代理 (Proxy)：** 選配的 `channels.telegram.proxy` 透過 grammY 的 `client.baseFetch` 使用 `undici.ProxyAgent`。
- **Webhook 支援：** `webhook-set.ts` 封裝了 `setWebhook/deleteWebhook`；`webhook.ts` 裝載了具備健康檢查與優雅關機 (graceful shutdown) 功能的回呼 (callback)。當設定了 `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` 時，Gateway 會啟用 webhook 模式（否則使用 long-poll）。
- **工作階段 (Sessions)：** 私訊對話會合併至智慧代理主工作階段 (`agent:<agentId>:<mainKey>`)；群組則使用 `agent:<agentId>:telegram:group:<chatId>`；回覆會路由回同一個頻道。
- **設定選項：** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (允許清單 + 預設標記), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`, `channels.telegram.webhookHost`。
- **草稿串流 (Draft streaming)：** 選配的 `channels.telegram.streamMode` 在私訊話題對話 (Bot API 9.3+) 中使用 `sendMessageDraft`。這與頻道的區塊串流傳輸 (block streaming) 是分開的。
- **測試：** grammY 模擬 (mocks) 涵蓋了私訊 + 群組標記門控以及對外發送；歡迎提供更多媒體/webhook 測試資料 (fixtures)。

待解決問題

- 若遇到 Bot API 429 錯誤，選配的 grammY 插件 (節流器)。
- 新增更多結構化的媒體測試 (貼圖、語音訊息)。
- 使 webhook 監聽連接埠 (port) 可設定 (目前固定為 8787，除非透過 Gateway 連接)。
