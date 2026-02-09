---
summary: "將入站自動回覆執行序列化的指令佇列設計"
read_when:
  - 變更自動回覆的執行方式或並行度
title: "指令佇列"
---

# 指令佇列 (2026-01-16)

我們透過一個小型的行程內佇列，將所有入站自動回覆的執行（所有頻道）序列化，以防止多個代理程式執行互相衝突，同時仍允許跨工作階段的安全並行。

## 為什麼

- 自動回覆執行可能成本高昂（LLM 呼叫），且當多則入站訊息在短時間內抵達時，容易彼此衝突。
- 序列化可避免競逐共用資源（工作階段檔案、記錄、CLI stdin），並降低上游速率限制的風險。

## How it works

- 具備通道（lane）感知的 FIFO 佇列，會以可設定的並行上限排空各通道（未設定的通道預設為 1；main 預設為 4，subagent 為 8）。
- `runEmbeddedPiAgent` 依 **工作階段金鑰**（通道 `session:<key>`）入佇列，以保證每個工作階段同時間只有一個有效執行。
- 接著，每個工作階段的執行會被排入 **全域通道**（預設為 `main`），因此整體並行度受 `agents.defaults.maxConcurrent` 限制。
- 啟用詳細記錄時，若排隊等待超過約 2 秒，佇列中的執行會在開始前送出簡短提示。
- 輸入中指示（typing indicators）仍會在入佇列時立即觸發（若頻道支援），因此在輪到我們之前，使用者體驗不會改變。

## 佇列模式（依頻道）

入站訊息可以即時引導目前的執行、等待後續回合，或同時進行：

- `steer`：立即注入目前的執行（在下一個工具邊界之後取消尚未完成的工具呼叫）。若非串流，則回退為後續回合。 若未進行串流，則會回退為 followup。
- `followup`：在目前執行結束後，排入下一個代理程式回合。
- `collect`：將所有佇列中的訊息合併為**單一**個 followup 回合（預設）。 如果訊息目標為不同的頻道／執行緒，則會各自排空，以保留路由。
- `steer-backlog`（亦稱 `steer+backlog`）：現在引導 **且** 保留訊息以供後續回合使用。
- `interrupt`（舊版）：中止該工作階段的作用中執行，然後執行最新的訊息。
- `queue`（舊版別名）：同 `steer`。

Steer-backlog 表示在引導執行之後你可以取得後續回應，因此串流介面看起來可能會像是重複的。 如果你希望每個傳入訊息只產生一個回應，請優先使用 `collect`/`steer`。
將 `/queue collect` 作為獨立指令發送（每個工作階段一次），或設定 `messages.queue.byChannel.discord: "collect"`。

預設值（設定中未指定時）：

- 所有介面 → `collect`

可透過 `messages.queue` 進行全域或依頻道設定：

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

選項適用於 `followup`、`collect` 與 `steer-backlog`（以及當 `steer` 回退為後續回合時）：

- `debounceMs`：在啟動後續回合前等待安靜期（避免「繼續、繼續」）。
- `cap`：每個工作階段可佇列的最大訊息數。
- `drop`：溢位策略（`old`、`new`、`summarize`）。

Summarize 會保留一份被丟棄訊息的精簡條列清單，並將其作為合成的後續提示注入。
預設值：`debounceMs: 1000`、`cap: 20`、`drop: summarize`。

## 每個工作階段的覆寫設定

- 將 `/queue <mode>` 作為獨立指令送出，以儲存目前工作階段的模式。
- 選項可組合：`/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` 或 `/queue reset` 會清除工作階段覆寫。

## 範圍與保證

- 適用於所有使用 Gateway 回覆管線的入站頻道之自動回覆代理程式執行（WhatsApp web、Telegram、Slack、Discord、Signal、iMessage、webchat 等）。
- 預設通道（`main`）在整個程序中用於傳入事件 + 主要心跳；設定 `agents.defaults.maxConcurrent` 以允許多個工作階段並行。
- 可能存在其他通道（例如 `cron`、`subagent`），使背景工作能並行執行而不阻塞入站回覆。
- 每個工作階段的通道可確保同一時間只有一個代理執行會接觸到該工作階段。
- 無外部相依或背景工作執行緒；純 TypeScript + promises。

## 疑難排解

- 若指令看似卡住，請啟用詳細記錄，並查看是否有「queued for …ms」的行，以確認佇列正在排空。
- 如果你需要查看佇列深度，請啟用詳細日誌並留意佇列計時相關的行。
