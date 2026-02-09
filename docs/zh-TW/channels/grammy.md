---
summary: "透過 grammY 進行 Telegram Bot API 整合，含設定注意事項"
read_when:
  - 處理 Telegram 或 grammY 流程時
title: grammY
---

# grammY 整合（Telegram Bot API）

# 為什麼選擇 grammY

- 以 TS 為優先的 Bot API 客戶端，內建 long-poll + webhook 輔助工具、中介軟體、錯誤處理與速率限制器。
- 比手寫 fetch + FormData 更乾淨的媒體輔助工具；支援所有 Bot API 方法。
- 3. 可擴充性：透過自訂 fetch 的代理支援、工作階段中介軟體（選用）、型別安全的 context。

# 4. 我們已交付的內容

- **單一客戶端路徑：** 已移除基於 fetch 的實作；grammY 現為唯一的 Telegram 客戶端（傳送 + Gateway 閘道器），且預設啟用 grammY 節流器。
- **Gateway：** `monitorTelegramProvider` 建立一個 grammY `Bot`，串接提及／允許清單的閘道、透過 `getFile`/`download` 下載媒體，並以 `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument` 傳遞回覆。透過 `webhookCallback` 支援 long-poll 或 webhook。 5. 透過 `webhookCallback` 支援長輪詢或 webhook。
- **Proxy：** 選用的 `channels.telegram.proxy` 透過 grammY 的 `client.baseFetch` 使用 `undici.ProxyAgent`。
- **Webhook 支援：** `webhook-set.ts` 封裝 `setWebhook/deleteWebhook`；`webhook.ts` 託管回呼，包含健康檢查與優雅關閉。當設定 `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` 時，Gateway 會啟用 webhook 模式（否則使用 long-poll）。 6. 當設定 `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` 時，Gateway 會啟用 webhook 模式（否則會使用長輪詢）。
- **工作階段：** 私聊會合併到代理程式的主要工作階段（`agent:<agentId>:<mainKey>`）；群組使用 `agent:<agentId>:telegram:group:<chatId>`；回覆會路由回相同的頻道。
- **設定旋鈕：** `channels.telegram.botToken`、`channels.telegram.dmPolicy`、`channels.telegram.groups`（允許清單 + 提及預設）、`channels.telegram.allowFrom`、`channels.telegram.groupAllowFrom`、`channels.telegram.groupPolicy`、`channels.telegram.mediaMaxMb`、`channels.telegram.linkPreview`、`channels.telegram.proxy`、`channels.telegram.webhookSecret`、`channels.telegram.webhookUrl`。
- **草稿串流：** 選用的 `channels.telegram.streamMode` 在私有主題聊天中使用 `sendMessageDraft`（Bot API 9.3+）。這與頻道的區塊串流是分開的。 7. 這與頻道區塊串流是分開的。
- **測試：** grammY 模擬涵蓋私訊 + 群組提及閘道，以及對外傳送；仍歡迎更多媒體／webhook 的測試樣例。

開放問題

- 若遇到 Bot API 429，是否啟用選用的 grammY 外掛（節流器）。
- 8. 新增更多結構化媒體測試（貼圖、語音訊息）。
- 讓 webhook 監聽連接埠可設定（目前固定為 8787，除非經由 Gateway 閘道器 串接）。
