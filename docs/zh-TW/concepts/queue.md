```
---
summary: "將傳入的自動回覆運行序列化的指令佇列設計"
read_when:
  - 變更自動回覆執行或並行性
title: "指令佇列"
---

# 指令佇列 (2026-01-16)

我們透過一個微小的處理中佇列來序列化傳入的自動回覆運行（所有頻道），以防止多個智慧代理運行發生衝突，同時仍允許跨工作階段的安全並行。

## 原因

- 自動回覆運行可能成本高昂（LLM 呼叫），當多個傳入訊息同時到達時可能會發生衝突。
- 序列化可避免爭奪共享資源（工作階段檔案、日誌、CLI stdin），並減少上游速率限制的機會。

## 運作方式

- 具備通道感知功能的 FIFO 佇列以可設定的並行上限（未設定通道預設為 1；main 預設為 4，subagent 預設為 8）排空每個通道。
- `runEmbeddedPiAgent` 透過**工作階段金鑰**（通道 `session:<key>`）進行排入佇列，以確保每個工作階段只有一個活躍的運行。
- 然後，每個工作階段運行都會排入**全域通道**（預設為 `main`），因此整體並行性受限於 `agents.defaults.maxConcurrent`。
- 啟用詳細日誌記錄時，如果排入佇列的運行在開始前等待超過約 2 秒，則會發出簡短通知。
- 輸入指示符號仍會在排入佇列時立即觸發（如果頻道支援），因此在我們等待輪到我們時，使用者體驗保持不變。

## 佇列模式（每個頻道）

傳入訊息可以引導當前運行、等待後續回合，或兩者兼顧：

- `steer`：立即注入當前運行（在下一個工具邊界之後取消擱置中的工具呼叫）。如果未串流傳輸，則會回退到 followup。
- `followup`：在當前運行結束後，排入佇列以進行下一個智慧代理回合。
- `collect`：將所有排入佇列的訊息合併到**單一** followup 回合（預設）。如果訊息指向不同的頻道/執行緒，則它們會單獨排空以保留路由。
- `steer-backlog`（又稱 `steer+backlog`）：立即引導**並**保留訊息以進行 followup 回合。
- `interrupt`（舊版）：終止該工作階段的活躍運行，然後運行最新的訊息。
- `queue`（舊版別名）：與 `steer` 相同。

Steer-backlog 表示您可以在引導運行之後獲得 followup 回覆，因此
串流傳輸介面可能會看起來重複。如果您想要每個傳入訊息一個回覆，則偏好使用 `collect`/`steer`。
將 `/queue collect` 作為獨立指令發送（每個工作階段）或將 `messages.queue.byChannel.discord: "collect"` 設定。

預設值（在設定中未設定時）：

- 所有介面 → `collect`

透過 `messages.queue` 全域或按頻道設定：

```json5
{
  messages: {
    queue: {
      mode: "collect",
      debounceMs: 1000,
      cap: 20,
      drop: "summarize",
      byChannel: { discord: "collect" },
    },
  },
}
```

## 佇列選項

選項適用於 `followup`、`collect` 和 `steer-backlog`（以及當 `steer` 回退到 followup 時）：

- `debounceMs`：在開始 followup 回合之前等待靜默（防止「繼續、繼續」）。
- `cap`：每個工作階段的最大排入佇列訊息數。
- `drop`：溢出策略（`old`、`new`、`summarize`）。

Summarize 會保留一個簡短的已丟棄訊息項目符號列表，並將其作為合成的 followup 提示注入。
預設值：`debounceMs: 1000`、`cap: 20`、`drop: summarize`。

## 每個工作階段覆寫

- 發送 `/queue <mode>` 作為獨立指令，以儲存當前工作階段的模式。
- 選項可以組合：`/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` 或 `/queue reset` 清除工作階段覆寫。

## 範圍與保證

- 適用於所有使用 Gateway 回覆管線的傳入頻道（WhatsApp web、Telegram、Slack、Discord、Signal、iMessage、webchat 等）的自動回覆智慧代理運行。
- 預設通道（`main`）是整個處理程序用於傳入 + 主要心跳；設定 `agents.defaults.maxConcurrent` 以允許多個工作階段並行。
- 可能存在其他通道（例如 `cron`、`subagent`），因此背景工作可以並行運行而不會阻擋傳入回覆。
- 每個工作階段的通道保證一次只有一個智慧代理運行觸及給定工作階段。
- 沒有外部依賴或背景工作執行緒；純粹的 TypeScript + promises。

## 疑難排解

- 如果指令看起來卡住，請啟用詳細日誌並尋找「queued for …ms」行，以確認佇列正在排空。
- 如果您需要佇列深度，請啟用詳細日誌並觀察佇列時間行。
```
