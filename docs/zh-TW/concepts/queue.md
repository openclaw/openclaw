---
summary: "串聯處理傳入自動回覆執行的指令佇列設計"
read_when:
  - 變更自動回覆執行或並行性時
title: "指令佇列"
---

# 指令佇列 (2026-01-16)

我們透過一個微型的處理程序內 (in-process) 佇列，將傳入的自動回覆執行（所有頻道）串聯起來，以防止多個智慧代理執行發生衝突，同時仍允許工作階段之間的安全並行處理。

## 為什麼

- 自動回覆執行可能非常昂貴（LLM 呼叫），且當多個傳入訊息同時抵達時可能會發生衝突。
- 串聯處理可避免爭奪共享資源（工作階段檔案、日誌、CLI stdin），並減少觸發上游速率限制 (rate limits) 的機會。

## 運作方式

- 一個具備車道 (lane) 感知的 FIFO 佇列會根據可設定的並行上限來處理每個車道（未設定車道的預設值為 1；main 預設為 4，subagent 預設為 8）。
- `runEmbeddedPiAgent` 依據 **工作階段鍵名 (session key)**（車道為 `session:<key>`）進行排隊，以保證每個工作階段只有一個活動中的執行。
- 每個工作階段執行接著會排入 **全域車道**（預設為 `main`），因此整體並行性受到 `agents.defaults.maxConcurrent` 的限制。
- 當啟用詳細日誌時，若排隊中的執行在開始前等待超過約 2 秒，會發出簡短通知。
- 排隊時「輸入中」指示器仍會立即觸發（若頻道支援），因此在等待期間使用者體驗保持不變。

## 佇列模式（按頻道）

傳入訊息可以引導 (steer) 當前執行、等待後續回合，或兩者兼具：

- `steer`: 立即注入當前執行（在下一個工具邊界後取消待處理的工具呼叫）。若非串流傳輸，則回退至 followup。
- `followup`: 在當前執行結束後，為下一個智慧代理回合排隊。
- `collect`: 將所有排隊中的訊息合併為 **單次** 後續回合（預設）。若訊息針對不同頻道/執行緒，則會分別處理以保留路由。
- `steer-backlog` (又名 `steer+backlog`): 現在引導 **並** 保留訊息供後續回合使用。
- `interrupt` (舊版): 中止該工作階段的活動執行，然後執行最新訊息。
- `queue` (舊版別名): 與 `steer` 相同。

Steer-backlog 意味著您可以在引導執行後獲得後續回應，因此串流介面可能會看起來像重複。如果您希望每條傳入訊息只有一個回應，請優先使用 `collect`/`steer`。
發送 `/queue collect` 作為獨立指令（按工作階段設定）或設定 `messages.queue.byChannel.discord: "collect"`。

預設值（未在設定中指定時）：

- 所有介面 → `collect`

透過 `messages.queue` 進行全域或按頻道設定：

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

選項適用於 `followup`、`collect` 和 `steer-backlog`（以及當 `steer` 回退至 followup 時）：

- `debounceMs`: 在開始後續回合前等待安靜時間（防止「繼續，繼續」的現象）。
- `cap`: 每個工作階段排隊訊息的最大數量。
- `drop`: 溢出政策 (`old`, `new`, `summarize`)。

Summarize 會保留被捨棄訊息的簡短項目清單，並將其作為合成的後續提示注入。
預設值：`debounceMs: 1000`, `cap: 20`, `drop: summarize`。

## 按工作階段覆寫

- 發送 `/queue <mode>` 作為獨立指令，為當前工作階段儲存模式。
- 選項可以組合：`/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` 或 `/queue reset` 會清除工作階段覆寫設定。

## 範圍與保證

- 適用於所有使用 Gateway 回覆管線的傳入頻道（WhatsApp web、Telegram、Slack、Discord、Signal、iMessage、網頁聊天等）的自動回覆智慧代理執行。
- 預設車道 (`main`) 適用於整個處理程序的傳入訊息 + 主要心跳；設定 `agents.defaults.maxConcurrent` 以允許並行處理多個工作階段。
- 可能存在額外的車道（例如 `cron`, `subagent`），以便背景作業可以並行執行而不阻塞傳入回覆。
- 按工作階段設定的車道保證同一時間只有一個智慧代理執行會觸及指定的工作階段。
- 無外部依賴或背景工作執行緒；純 TypeScript + Promises。

## 疑難排解

- 若指令似乎卡住，請啟用詳細日誌並尋找「queued for …ms」行以確認佇列正在處理。
- 若您需要了解佇列深度，請啟用詳細日誌並觀察佇列時間行。
