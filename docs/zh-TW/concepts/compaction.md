---
summary: "內容視窗 (Context window) + 壓縮 (compaction)：OpenClaw 如何將工作階段維持在模型限制內"
read_when:
  - 你想瞭解自動壓縮與 /compact
  - 你正在對達到內容限制的長工作階段進行除錯
title: "壓縮"
---

# 內容視窗與壓縮

每個模型都有一個**內容視窗** (context window)（其可見的最大權杖數）。運行時間較長的對話會累積訊息和工具結果；一旦視窗空間不足，OpenClaw 就會**壓縮** (compact) 舊的歷史記錄，以維持在限制範圍內。

## 什麼是壓縮

壓縮會將**舊的對話內容摘要**成一條簡短的摘要項目，並保留最近的訊息。摘要會儲存在工作階段歷史記錄中，因此未來的請求將使用：

- 壓縮摘要
- 壓縮點之後的最近訊息

壓縮會**持久化**儲存在工作階段的 JSONL 歷史檔案中。

## 設定

在 `openclaw.json` 中使用 `agents.defaults.compaction` 設定來配置壓縮行為（模式、目標權杖數等）。

## 自動壓縮（預設開啟）

當工作階段接近或超過模型的內容視窗時，OpenClaw 會觸發自動壓縮，並可能使用壓縮後的內容重試原始請求。

你會看到：

- 詳細模式下顯示 `🧹 Auto-compaction complete`
- `/status` 顯示 `🧹 Compactions: <count>`

在壓縮之前，OpenClaw 可以執行一次**靜默記憶體刷新** (silent memory flush) 以將持久筆記儲存到磁碟。詳情及設定請參閱 [記憶體](/concepts/memory)。

## 手動壓縮

使用 `/compact`（可選擇性加入指令）來強制執行一次壓縮：

```
/compact Focus on decisions and open questions
```

## 內容視窗來源

內容視窗取決於特定模型。OpenClaw 使用來自已設定供應商目錄的模型定義來確定限制。

## 壓縮 vs 剪裁

- **壓縮 (Compaction)**：摘要內容並**持久化**儲存在 JSONL 中。
- **工作階段剪裁 (Session pruning)**：僅在每次請求時於**記憶體中**修剪舊的**工具結果**。

有關剪裁的詳情，請參閱 [/concepts/session-pruning](/concepts/session-pruning)。

## 提示

- 當感覺工作階段變得陳舊或內容過於臃腫時，請使用 `/compact`。
- 大型工具輸出已經過截斷；剪裁可以進一步減少工具結果的累積。
- 如果你需要重新開始，`/new` 或 `/reset` 會啟動一個新的工作階段識別碼 (session id)。
