---
summary: "Context window + compaction: how OpenClaw keeps sessions under model limits"
read_when:
  - You want to understand auto-compaction and /compact
  - You are debugging long sessions hitting context limits
title: Compaction
---

# 上下文視窗與壓縮

每個模型都有一個**上下文視窗**（最大可見 token 數）。長時間的對話會累積訊息和工具結果；當視窗接近上限時，OpenClaw 會**壓縮**較舊的歷史紀錄以維持在限制內。

## 什麼是壓縮

壓縮會將**較舊的對話摘要**成一個精簡的摘要條目，並保留近期訊息不變。該摘要會存放在會話歷史中，未來的請求會使用：

- 壓縮摘要
- 壓縮點之後的近期訊息

壓縮會**持久化**在會話的 JSONL 歷史中。

## 設定

使用 `agents.defaults.compaction` 設定於你的 `openclaw.json` 中來設定壓縮行為（模式、目標 token 數等）。壓縮摘要預設會保留不透明識別碼 (`identifierPolicy: "strict"`)。你可以用 `identifierPolicy: "off"` 覆寫此行為，或用 `identifierPolicy: "custom"` 和 `identifierInstructions` 提供自訂文字。

你也可以透過 `agents.defaults.compaction.model` 指定不同的模型來執行壓縮摘要。當你的主要模型是本地或小型模型，且想用更強大的模型產生壓縮摘要時，這非常有用。該覆寫接受任何 `provider/model-id` 字串：

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "model": "openrouter/anthropic/claude-sonnet-4-5"
      }
    }
  }
}
```

這也適用於本地模型，例如專門用於摘要的第二個 Ollama 模型，或是微調過的壓縮專家：

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "model": "ollama/llama3.1:8b"
      }
    }
  }
}
```

若未設定，壓縮會使用代理的主要模型。

## 自動壓縮（預設開啟）

當會話接近或超過模型的上下文視窗時，OpenClaw 會觸發自動壓縮，並可能使用壓縮後的上下文重試原始請求。

你會看到：

- `🧹 Auto-compaction complete` 在詳細模式下
- `/status` 顯示 `🧹 Compactions: <count>`

在壓縮之前，OpenClaw 可以執行 **靜默記憶體刷新**，將持久化的筆記存到磁碟。詳情與設定請參考 [記憶體](/concepts/memory)。

## 手動壓縮

使用 `/compact`（可選搭配指令）來強制執行壓縮流程：

```
/compact Focus on decisions and open questions
```

## 上下文視窗來源

上下文視窗是模型特定的。OpenClaw 會使用已設定提供者目錄中的模型定義來決定限制。

## 壓縮與修剪的差異

- **壓縮**：摘要並以 JSONL 格式**持久化**。
- **會話修剪**：僅修剪舊的**工具結果**，**在記憶體中**，每次請求執行。

修剪詳情請參考 [/concepts/session-pruning](/concepts/session-pruning)。

## OpenAI 伺服器端壓縮

OpenClaw 也支援 OpenAI 回應的伺服器端壓縮提示，適用於相容的直接 OpenAI 模型。這與本地 OpenClaw 壓縮是分開的，且可同時運作。

- 本地壓縮：OpenClaw 將摘要持久化到會話 JSONL。
- 伺服器端壓縮：當 `store` + `context_management` 啟用時，OpenAI 在提供者端壓縮上下文。

模型參數與覆寫設定請參考 [OpenAI 提供者](/providers/openai)。

## 小技巧

- 當對話感覺陳舊或上下文過於龐大時，使用 `/compact`。
- 大量工具輸出已經會被截斷；修剪可以進一步減少工具結果的累積。
- 如果需要全新開始，`/new` 或 `/reset` 可啟動新的會話 ID。
