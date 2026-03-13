---
summary: Command queue design that serializes inbound auto-reply runs
read_when:
  - Changing auto-reply execution or concurrency
title: Command Queue
---

# Command Queue (2026-01-16)

我們透過一個小型的內部處理佇列來序列化所有通道的進入自動回覆執行，以防止多個代理執行之間的衝突，同時仍然允許在會話之間安全地進行平行處理。

## 為什麼

- 自動回覆執行可能會很昂貴（LLM 調用），並且當多個進來的訊息接近到達時可能會發生衝突。
- 序列化可以避免競爭共享資源（會話檔案、日誌、CLI 標準輸入），並減少上游速率限制的機會。

## 如何運作

- 一個具通道感知的 FIFO 隊列以可設定的併發上限排出每個通道（未設定的通道預設為 1；主通道預設為 4，子代理預設為 8）。
- `runEmbeddedPiAgent` 透過 **會話金鑰**（通道 `session:<key>`）進行排隊，以保證每個會話只有一個活躍的執行。
- 每個會話的執行隨後被排入 **全局通道**（預設為 `main`），因此整體的並行性受到 `agents.defaults.maxConcurrent` 的限制。
- 當啟用詳細日誌記錄時，如果排隊的執行在開始前等待超過約 2 秒，則會發出簡短通知。
- 輸入指示器仍然會在排隊時立即觸發（當通道支援時），因此在等待我們的輪到時，使用者體驗不會改變。

## 隊列模式（每個通道）

[[BLOCK_1]]  
進來的訊息可以引導當前的執行、等待後續的回合，或同時執行這兩者：  
[[BLOCK_1]]

- `steer`: 立即注入到當前執行中（在下一個工具邊界後取消待處理的工具調用）。如果不是串流，則回退到後續處理。
- `followup`: 在當前執行結束後，將其排入下一個代理回合。
- `collect`: 將所有排隊的消息合併為一個**單一**的後續回合（預設）。如果消息針對不同的通道/線程，則會單獨處理以保留路由。
- `steer-backlog`（也稱為 `steer+backlog`）: 現在引導**並**保留該消息以便後續回合使用。
- `interrupt`（舊版）: 中止該會話的活動執行，然後執行最新的消息。
- `queue`（舊版別名）: 與 `steer` 相同。

Steer-backlog 意味著您可以在引導執行後獲得後續回應，因此串流表面可能看起來像是重複的。如果您希望每個進入的訊息只獲得一個回應，請優先使用 `collect`/`steer`。將 `/queue collect` 作為獨立命令發送（每個會話）或設置 `messages.queue.byChannel.discord: "collect"`。

Defaults (when unset in config):

- 所有表面 → `collect`

透過 `messages.queue` 全域或按頻道進行設定：

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

## Queue options

選項適用於 `followup`、`collect` 和 `steer-backlog`（以及當 `steer` 回退到後續時）：

- `debounceMs`: 在開始後續回合前等待安靜（防止「繼續，繼續」）。
- `cap`: 每個會話的最大排隊訊息數。
- `drop`: 溢出政策 (`old`, `new`, `summarize`)。

- 總結會保持一個簡短的丟失訊息清單，並將其作為合成的後續提示注入。
- 預設值：`debounceMs: 1000`，`cap: 20`，`drop: summarize`。

## 每次會話的覆蓋設定

- 將 `/queue <mode>` 作為獨立指令發送，以儲存當前會話的模式。
- 選項可以結合使用：`/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` 或 `/queue reset` 會清除會話的覆蓋設定。

## 範圍與保證

- 適用於所有使用網關回覆管道的自動回覆代理，涵蓋所有進入通道（如 WhatsApp 網頁、Telegram、Slack、Discord、Signal、iMessage、網頁聊天等）。
- 預設通道 (`main`) 是針對進入通道 + 主要心跳的全域設定；設置 `agents.defaults.maxConcurrent` 以允許多個會話並行執行。
- 可能存在額外的通道（例如 `cron`, `subagent`），以便背景任務可以並行執行而不會阻塞進入回覆。
- 每個會話的通道保證同一時間只有一個代理執行觸及特定會話。
- 無外部依賴或背景工作執行緒；純 TypeScript + promises。

## 故障排除

- 如果指令似乎卡住，請啟用詳細日誌並尋找「queued for …ms」的行，以確認佇列正在排空。
- 如果您需要佇列深度，請啟用詳細日誌並觀察佇列計時行。
