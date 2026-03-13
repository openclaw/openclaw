---
summary: "Context window + compaction: how OpenClaw keeps sessions under model limits"
read_when:
  - You want to understand auto-compaction and /compact
  - You are debugging long sessions hitting context limits
title: Compaction
---

# Context Window & Compaction

每個模型都有一個 **上下文窗口**（它可以看到的最大標記數）。長時間執行的對話會累積消息和工具結果；一旦窗口變得緊湊，OpenClaw 會 **壓縮** 舊的歷史記錄以保持在限制範圍內。

## 什麼是壓縮（Compaction）

Compaction **將較舊的對話** 總結為一個簡潔的摘要條目，並保持最近的消息不變。摘要存儲在會話歷史中，因此未來的請求使用：

- 壓縮摘要
- 壓縮點之後的最近訊息

Compaction **持久化**於會話的 JSONL 歷史中。

## Configuration

在您的 `openclaw.json` 中使用 `agents.defaults.compaction` 設定來設定壓縮行為（模式、目標 token 等）。壓縮摘要預設會保留不透明識別碼 (`identifierPolicy: "strict"`)。您可以使用 `identifierPolicy: "off"` 來覆蓋此設定，或使用 `identifierPolicy: "custom"` 和 `identifierInstructions` 提供自訂文本。

您可以選擇性地透過 `agents.defaults.compaction.model` 指定不同的模型來進行壓縮摘要。當您的主要模型是本地或小型模型，而您希望由更強大的模型生成壓縮摘要時，這將非常有用。覆蓋接受任何 `provider/model-id` 字串：

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

這也適用於本地模型，例如專門用於摘要的第二個 Ollama 模型或經過微調的壓縮專家：

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

當未設置時，壓縮將使用代理的主要模型。

## 自動壓縮（預設開啟）

當會話接近或超過模型的上下文窗口時，OpenClaw 會觸發自動壓縮，並可能使用壓縮後的上下文重試原始請求。

你會看到：

- `🧹 Auto-compaction complete` 在詳細模式下
- `/status` 顯示 `🧹 Compactions: <count>`

在壓縮之前，OpenClaw 可以執行 **靜默記憶體清除** 以將持久性筆記儲存到磁碟。詳情和設定請參見 [Memory](/concepts/memory)。

## 手動壓縮

使用 `/compact`（可選擇性地附上指令）來強制執行壓縮過程：

```
/compact Focus on decisions and open questions
```

## Context window source

上下文窗口是特定於模型的。OpenClaw 使用設定的提供者目錄中的模型定義來確定限制。

## Compaction 與修剪

- **壓縮**: 以 JSONL 格式總結並 **持久化**。
- **會話修剪**: 僅修剪舊的 **工具結果**，**在記憶體中**，根據請求進行。

請參閱 [/concepts/session-pruning](/concepts/session-pruning) 以獲取修剪的詳細資訊。

## OpenAI 伺服器端壓縮

OpenClaw 也支援 OpenAI 回應的伺服器端壓縮提示，適用於相容的直接 OpenAI 模型。這與本地的 OpenClaw 壓縮是分開的，並且可以與之並行執行。

- 本地壓縮：OpenClaw 將摘要並持久化到會話 JSONL 中。
- 伺服器端壓縮：當 `store` + `context_management` 被啟用時，OpenAI 在提供者端壓縮上下文。

請參閱 [OpenAI provider](/providers/openai) 以獲取模型參數和覆蓋設定。

## Tips

- 當會話感覺陳舊或上下文過於冗長時，請使用 `/compact`。
- 大型工具的輸出已經被截斷；修剪可以進一步減少工具結果的累積。
- 如果您需要一個全新的開始，`/new` 或 `/reset` 會啟動一個新的會話 ID。
