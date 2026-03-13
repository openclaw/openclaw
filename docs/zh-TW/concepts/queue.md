---
summary: Command queue design that serializes inbound auto-reply runs
read_when:
  - Changing auto-reply execution or concurrency
title: Command Queue
---

# 指令佇列 (2026-01-16)

我們透過一個小型的程序內佇列序列化所有頻道的入站自動回覆執行，避免多個代理執行互相衝突，同時仍允許跨會話的安全平行處理。

## 為什麼

- 自動回覆執行可能很耗費資源（LLM 呼叫），且當多個入站訊息接近同時到達時，可能會互相衝突。
- 序列化避免爭奪共享資源（會話檔案、日誌、CLI stdin），並降低上游速率限制的機率。

## 運作方式

- 一個支援通道識別的先進先出佇列，依據可設定的併發上限排出每個通道（未設定通道預設為 1；主通道預設為 4，子代理預設為 8）。
- `runEmbeddedPiAgent` 依 **會話鍵**（通道 `session:<key>`）入佇列，確保每個會話只有一個執行中任務。
- 每個會話執行接著被排入一個 **全域通道**（預設為 `main`），整體平行度受 `agents.defaults.maxConcurrent` 限制。
- 啟用詳細日誌時，若排隊等待超過約 2 秒，排隊的執行會發出簡短通知。
- 打字指示器在入佇列時立即觸發（若頻道支援），確保使用者體驗在等待期間不受影響。

## 佇列模式（每個頻道）

入站訊息可以引導當前執行、等待後續回合，或兩者兼具：

- `steer`：立即注入當前執行（在下一個工具邊界後取消待處理的工具呼叫）。若非串流模式，則退回為後續回合。
- `followup`：排入下一個代理回合，待當前執行結束後執行。
- `collect`：將所有排隊訊息合併為 **單一** 後續回合（預設）。若訊息針對不同頻道/線程，則分別排出以保留路由。
- `steer-backlog`（又名 `steer+backlog`）：立即引導 **且** 保留訊息作為後續回合。
- `interrupt`（舊版）：中止該會話的執行，然後執行最新訊息。
- `queue`（舊版別名）：同 `steer`。

引導後備表示你可以在引導執行後獲得後續回應，因此串流介面可能看起來像重複回應。若想要每則入站訊息只得到一個回應，建議使用 `collect`/`steer`。
可單獨發送 `/queue collect`（每會話）或設定 `messages.queue.byChannel.discord: "collect"`。

預設值（未在設定中指定時）：

- 所有介面 → `collect`

可透過 `messages.queue` 全域或逐頻道設定：

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

選項適用於 `followup`、`collect` 和 `steer-backlog`（以及當 `steer` 回退到後續時）：

- `debounceMs`：在開始後續回合前等待靜默（避免「繼續，繼續」的情況）。
- `cap`：每個會話的最大排隊訊息數。
- `drop`：溢出策略（`old`、`new`、`summarize`）。

Summarize 會保留一個簡短的被丟棄訊息清單，並將其注入為合成的後續提示。
預設值：`debounceMs: 1000`、`cap: 20`、`drop: summarize`。

## 每會話覆寫

- 發送 `/queue <mode>` 作為獨立指令以儲存當前會話的模式。
- 選項可組合使用：`/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` 或 `/queue reset` 可清除會話覆寫。

## 範圍與保證

- 適用於所有使用 gateway 回覆流程的入站通道的自動回覆代理執行（WhatsApp web、Telegram、Slack、Discord、Signal、iMessage、webchat 等）。
- 預設通道（`main`）為全程式範圍，涵蓋入站與主要心跳；設定 `agents.defaults.maxConcurrent` 可允許多個會話並行。
- 可能存在額外通道（例如 `cron`、`subagent`），使背景工作可並行執行而不阻塞入站回覆。
- 每會話通道保證同一時間只有一個代理執行存取該會話。
- 無外部依賴或背景工作執行緒；純 TypeScript + promises。

## 疑難排解

- 若指令似乎卡住，請啟用詳細日誌並尋找「queued for …ms」行以確認佇列正在排出。
- 若需要佇列深度，請啟用詳細日誌並觀察佇列時間行。
