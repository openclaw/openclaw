---
summary: >-
  Status and next steps for decoupling Discord gateway listeners from
  long-running agent turns with a Discord-specific inbound worker
owner: openclaw
status: in_progress
last_updated: "2026-03-05"
title: Discord Async Inbound Worker Plan
---

# Discord 非同步入站工作者計畫

## 目標

將 Discord 監聽器的超時移除作為用戶可見的失敗模式，通過使進入的 Discord 談話異步化：

1. Gateway listener 快速接受並標準化進來的事件。
2. Discord 執行佇列儲存以我們今天使用的相同排序邊界為鍵的序列化任務。
3. 工作者在 Carbon listener 的生命週期之外執行實際的代理回合。
4. 回覆在執行完成後送回原始的頻道或線程。

這是針對排隊的 Discord 執行在 `channels.discord.eventQueue.listenerTimeout` 超時的長期解決方案，而代理執行本身仍在持續進行中。

## Current status

此計畫已部分實施。

[[BLOCK_1]]

- Discord 監聽器超時和 Discord 執行超時現在是獨立的設定。
- 接受的進入 Discord 回合被排入 `src/discord/monitor/inbound-worker.ts`。
- 現在工作者擁有長時間執行的回合，而不是 Carbon 監聽器。
- 現有的每路由排序由佇列鍵保留。
- Discord 工作者路徑存在超時回歸測試覆蓋。

請提供您希望翻譯的內容。

- 生產超時的錯誤已修正
- 長時間執行的回合不再因為 Discord 監聽器預算到期而中斷
- 工作者架構尚未完成

[[BLOCK_1]]

- `DiscordInboundJob` 仍然只有部分正規化，並且仍然保留著即時執行的參考
- 命令語義 (`stop`, `new`, `reset`, 未來的會話控制) 尚未完全原生於工作者
- 工作者的可觀察性和操作員狀態仍然很有限
- 目前仍然沒有重啟的持久性

## 為什麼會有這個

當前的行為將完整的代理回合與聆聽者的生命週期綁定在一起：

- `src/discord/monitor/listeners.ts` 應用超時和中止邊界。
- `src/discord/monitor/message-handler.ts` 將排隊的執行保持在該邊界內。
- `src/discord/monitor/message-handler.process.ts` 內聯執行媒體加載、路由、調度、輸入、草稿串流和最終回覆傳遞。

該架構有兩個不良特性：

- 長時間但健康的輪詢可以被監聽器看門狗中止
- 使用者即使在下游執行環境會產生回覆的情況下，也看不到任何回覆

提高超時設定有助於改善情況，但並不改變失敗模式。

## 非目標

- 在這次實作中，不要重新設計非 Discord 的頻道。
- 在第一次實作中，不要將其擴充為通用的所有頻道工作框架。
- 不要提取共享的跨頻道輸入工作者抽象；僅在明顯重複時共享低階原語。
- 在第一次實作中，除非需要安全落地，否則不要添加持久的崩潰恢復功能。
- 在此計畫中，不要更改路由選擇、綁定語義或 ACP 政策。

## 當前限制條件

目前的 Discord 處理路徑仍然依賴於一些不應該留在長期工作有效負載中的即時執行物件：

- Carbon `Client`
- 原始 Discord 事件形狀
- 記憶體中的公會歷史地圖
- 線程綁定管理器回調
- 實時輸入和草稿流狀態

我們已經將執行移至工作者佇列，但正規化邊界仍然不完整。目前，工作者是「在同一個過程中稍後執行，並使用一些相同的即時物件」，而不是完全以數據為主的工作邊界。

## Target architecture

### 1. Listener stage

`DiscordMessageListener` 仍然是進入點，但它的工作變為：

- 執行預檢和政策檢查
- 將接受的輸入標準化為可序列化的 `DiscordInboundJob`
- 將工作排入每個會話或每個通道的非同步佇列
- 一旦排入成功，立即返回給 Carbon

聽眾不應再擁有端到端 LLM 轉換的生命週期。

### 2. 正規化工作有效載荷

引入一個可序列化的工作描述符，該描述符僅包含執行該回合所需的數據。

[[BLOCK_1]]

- 路由身份
  - `agentId`
  - `sessionKey`
  - `accountId`
  - `channel`
- 傳遞身份
  - 目的地頻道 ID
  - 回覆目標訊息 ID
  - 如果存在，則為線程 ID
- 發送者身份
  - 發送者 ID、標籤、使用者名稱、標籤
- 頻道上下文
  - 公會 ID
  - 頻道名稱或簡稱
  - 線程元資料
  - 解決的系統提示覆蓋
- 正規化訊息內容
  - 基本文字
  - 有效訊息文字
  - 附件描述符或解決的媒體參考
- 門檻決策
  - 提及要求結果
  - 指令授權結果
  - 如果適用，則為綁定的會話或代理元資料

工作有效載荷不得包含活的 Carbon 物件或可變的閉包。

目前實作狀態：

- 部分完成
- `src/discord/monitor/inbound-job.ts` 存在並定義了工作者交接
- 負載仍然包含活躍的 Discord 執行時上下文，應進一步減少

### 3. Worker 階段

新增一個專門針對 Discord 的工作執行者，負責：

- 從 `DiscordInboundJob` 重建回合上下文
- 載入媒體及執行所需的任何額外通道元資料
- 派發代理回合
- 傳遞最終回覆有效載荷
- 更新狀態和診斷資訊

推薦位置：

- `src/discord/monitor/inbound-worker.ts`
- `src/discord/monitor/inbound-job.ts`

### 4. 訂購模型

訂單必須在給定的路徑邊界內保持與今天相同的順序。

推薦的金鑰：

- 使用與 `resolveDiscordRunQueueKey(...)` 相同的佇列鍵邏輯

這保留了現有的行為：

- 一個綁定的代理對話不會與自身交錯
- 不同的 Discord 頻道仍然可以獨立進行

### 5. 超時模型

在切換後，有兩個獨立的超時類別：

- 監聽器超時
  - 僅涵蓋標準化和排隊
  - 應該設置為短時間
- 執行超時
  - 可選、由工作者擁有、明確且對用戶可見
  - 不應該意外繼承自 Carbon 監聽器設置

這樣可以消除「Discord 網關監聽器保持存活」與「代理執行正常」之間的當前意外耦合。

## 建議的實施階段

### Phase 1: 正規化邊界

- 狀態：部分實作
- 完成：
  - 提取 `buildDiscordInboundJob(...)`
  - 添加工作者交接測試
- 剩餘：
  - 使 `DiscordInboundJob` 僅為純資料
  - 將即時執行時依賴移至工作者擁有的服務，而非每個工作負載
  - 停止通過將即時監聽器引用重新拼接回工作中來重建過程上下文

### Phase 2: 記憶體工作者佇列

- 狀態：已實作
- 完成：
  - 新增 `DiscordInboundWorkerQueue`，以解析的執行佇列鍵為索引
  - 監聽器將工作排入佇列，而不是直接等待 `processDiscordMessage(...)`
  - 工作者在過程中執行工作，僅在記憶體中進行

這是第一次功能切換。

### Phase 3: process split

- 狀態：尚未開始
- 將交付、輸入和草稿串流的擁有權移至面向工作者的適配器後面。
- 用工作者上下文重建取代直接使用即時預檢上下文。
- 如果需要，暫時保留 `processDiscordMessage(...)` 作為外觀，然後再進行拆分。

### Phase 4: 命令語義

- 狀態：尚未開始  
  確保當工作被排隊時，原生 Discord 指令仍然正常運作：

- `stop`
- `new`
- `reset`
- 任何未來的會話控制指令

工作者佇列必須公開足夠的執行狀態，以便命令能夠針對當前活動或排隊的回合。

### 第五階段：可觀察性與操作員使用者體驗

- 狀態：尚未開始
- 將佇列深度和活躍工作者數量發送到監控狀態
- 記錄入隊時間、開始時間、完成時間，以及超時或取消原因
- 在日誌中清楚顯示工作者擁有的超時或交付失敗

### Phase 6: 可選的耐久性後續措施

- 狀態：尚未開始  
  只有在記憶體版本穩定後：

- 決定排隊的 Discord 工作是否應該在閘道重啟後存活
- 如果是，持久化工作描述符和交付檢查點
- 如果不是，記錄明確的記憶體邊界

這應該是一個單獨的後續步驟，除非需要重新啟動恢復以著陸。

## File impact

當前主要檔案：

- `src/discord/monitor/listeners.ts`
- `src/discord/monitor/message-handler.ts`
- `src/discord/monitor/message-handler.preflight.ts`
- `src/discord/monitor/message-handler.process.ts`
- `src/discord/monitor/status.ts`

當前工作者檔案：

- `src/discord/monitor/inbound-job.ts`
- `src/discord/monitor/inbound-worker.ts`
- `src/discord/monitor/inbound-job.test.ts`
- `src/discord/monitor/message-handler.queue.test.ts`

可能的下一步接觸點：

- `src/auto-reply/dispatch.ts`
- `src/discord/monitor/reply-delivery.ts`
- `src/discord/monitor/thread-bindings.ts`
- `src/discord/monitor/native-command.ts`

## 下一步現在

下一步是使工作者邊界變得真實，而不是部分的。

[[BLOCK_1]]

1. 將即時執行時依賴移出 `DiscordInboundJob`
2. 將這些依賴保留在 Discord 工作者實例上
3. 將排隊的工作減少為純粹的 Discord 特定數據：
   - 路由身份
   - 傳遞目標
   - 發送者資訊
   - 正規化的訊息快照
   - 門檻和綁定決策
4. 從該純數據重建工作者執行上下文

在實際應用中，這意味著：

- `client`
- `threadBindings`
- `guildHistories`
- `discordRestFetch`
- 其他可變的僅限於執行時的句柄

應該停止依賴每個排隊的工作，而是應該依賴工作者本身或工作者擁有的適配器。

在那之後，下一步的後續操作應該是對 `stop`、`new` 和 `reset` 進行命令狀態清理。

## 測試計畫

保留現有的超時重現覆蓋範圍於：

`src/discord/monitor/message-handler.queue.test.ts`

新增測試以：

1. listener 在排入佇列後返回，無需等待完整的回合
2. 每條路由的排序得以保留
3. 不同的頻道仍然可以同時執行
4. 回覆會送達原始訊息的目的地
5. `stop` 取消當前的工作者擁有的執行
6. 工作者失敗會產生可見的診斷資訊，而不會阻塞後續的工作
7. 受 ACP 約束的 Discord 頻道在工作者執行下仍能正確路由

## 風險與緩解措施

- 風險：指令語義與當前的同步行為偏離  
  緩解措施：在同一切換中實現指令狀態的管道，而不是稍後進行

- 風險：回覆交付失去主題或回覆上下文  
  緩解措施：在 `DiscordInboundJob` 中將交付身份設為一級重要性

- 風險：在重試或佇列重啟期間發生重複發送  
  緩解措施：僅在記憶體中保留第一次傳送，或在持久化之前添加明確的傳送冪等性

- 風險: `message-handler.process.ts` 在遷移過程中變得更難以推理
  緩解措施: 在工作者切換之前或期間，將其拆分為正規化、執行和交付輔助工具

## Acceptance criteria

計畫在以下情況下完成：

1. Discord 監聽器的超時不再中止健康的長時間執行回合。
2. 監聽器的生命週期和代理回合的生命週期在程式碼中是兩個不同的概念。
3. 現有的每個會話排序得以保留。
4. ACP 綁定的 Discord 頻道透過相同的工作者路徑運作。
5. `stop` 針對工作者擁有的執行，而不是舊的監聽器擁有的呼叫堆疊。
6. 超時和交付失敗變成明確的工作者結果，而不是靜默的監聽器丟失。

## Remaining landing strategy

在後續的 PR 中完成這個：

1. 將 `DiscordInboundJob` 設為純資料，並將即時執行參考移至工作者上
2. 清理 `stop`、`new` 和 `reset` 的命令狀態擁有權
3. 增加工作者的可觀察性和操作員狀態
4. 決定是否需要耐久性，或明確記錄記憶體邊界

這仍然是一個有限的後續，如果保持在 Discord 上並且我們繼續避免過早的跨頻道工作者抽象。
