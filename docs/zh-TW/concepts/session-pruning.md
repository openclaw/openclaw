---
title: "工作階段修剪 (Session Pruning)"
summary: "工作階段修剪：修剪工具結果以減少上下文內容膨脹"
read_when:
  - 您想要減少工具輸出造成的 LLM 上下文增長
  - 您正在調整 agents.defaults.contextPruning
---

# 工作階段修剪 (Session Pruning)

工作階段修剪會在每次呼叫 LLM 之前，從記憶體中的上下文修剪**舊的工具結果**。它**不會**重寫磁碟上的工作階段歷程記錄 (`*.jsonl`)。

## 執行時機

- 當啟用 `mode: "cache-ttl"` 且該工作階段的上一次 Anthropic 呼叫早於 `ttl` 時。
- 僅影響發送到該次模型請求的訊息。
- 僅對 Anthropic API 呼叫（以及 OpenRouter 的 Anthropic 模型）有效。
- 為了獲得最佳效果，請將 `ttl` 與您的模型 `cacheControlTtl` 匹配。
- 修剪後，TTL 窗口會重置，因此後續請求將保留快取，直到 `ttl` 再次過期。

## 智慧預設 (Anthropic)

- **OAuth 或 setup-token** 設定檔：啟用 `cache-ttl` 修剪並將 heartbeat 設定為 `1h`。
- **API key** 設定檔：啟用 `cache-ttl` 修剪，將 heartbeat 設定為 `30m`，並在 Anthropic 模型上將預設 `cacheControlTtl` 設定為 `1h`。
- 如果您明確設定了這些值，OpenClaw **不會**覆蓋它們。

## 改善之處（成本 + 快取行為）

- **為什麼要修剪：** Anthropic 的提示詞快取 (prompt caching) 僅在 TTL 內有效。如果工作階段閒置超過 TTL，下一個請求將重新快取完整的提示詞，除非您先對其進行修剪。
- **什麼變得更便宜：** 修剪減少了 TTL 過期後第一個請求的 **cacheWrite** 大小。
- **為什麼 TTL 重置很重要：** 一旦執行修剪，快取窗口就會重置，因此後續請求可以重用新快取的提示詞，而不需要再次快取完整的歷程記錄。
- **它不會做什麼：** 修剪不會增加權杖 (tokens) 或產生「雙倍」成本；它只會改變 TTL 過期後第一個請求中被快取的內容。

## 哪些內容可以被修剪

- 僅限 `toolResult` 訊息。
- 使用者與智慧代理 (assistant) 訊息**永遠不會**被修改。
- 最後 `keepLastAssistants` 個智慧代理訊息會受到保護；在該截止點之前的工具結果將被修剪。
- 如果沒有足夠的智慧代理訊息來建立截止點，則會跳過修剪。
- 包含**圖片區塊 (image blocks)** 的工具結果會被跳過（永遠不會被修剪或清除）。

## 上下文窗口估算

修剪使用預估的上下文窗口（字元數 ≈ tokens × 4）。基準窗口依此順序解析：

1. `models.providers.*.models[].contextWindow` 覆蓋設定。
2. 模型定義的 `contextWindow`（來自模型註冊表）。
3. 預設 `200000` tokens。

如果設定了 `agents.defaults.contextTokens`，它將被視為解析窗口的上限（最小值）。

## 模式 (Mode)

### cache-ttl

- 僅當上一次 Anthropic 呼叫早於 `ttl`（預設為 `5m`）時，才會執行修剪。
- 執行時：採取與之前相同的軟修剪 (soft-trim) + 硬清除 (hard-clear) 行為。

## 軟修剪 vs 硬清除

- **軟修剪 (Soft-trim)**：僅針對過大的工具結果。
  - 保留頭部與尾部，插入 `...`，並附加原始大小的說明文字。
  - 跳過包含圖片區塊的結果。
- **硬清除 (Hard-clear)**：將整個工具結果替換為 `hardClear.placeholder`。

## 工具選擇

- `tools.allow` / `tools.deny` 支援 `*` 萬用字元。
- 拒絕 (Deny) 優先。
- 匹配不分大小寫。
- 空的允許清單代表允許所有工具。

## 與其他限制的互動

- 內建工具已經會截斷其自身的輸出；工作階段修剪是一個額外的層級，用於防止長時間運行的對話在模型上下文中累積過多的工具輸出。
- 壓縮 (Compaction) 是分開的：壓縮會進行摘要並持久化，而修剪是針對每個請求的暫時性行為。請參閱 [/concepts/compaction](/concepts/compaction)。

## 預設值（啟用時）

- `ttl`: `"5m"`
- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3`
- `hardClearRatio`: `0.5`
- `minPrunableToolChars`: `50000`
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## 範例

預設（關閉）：

```json5
{
  agent: {
    contextPruning: { mode: "off" },
  },
}
```

啟用 TTL 感知的修剪：

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

僅限制特定工具的修剪：

```json5
{
  agent: {
    contextPruning: {
      mode: "cache-ttl",
      tools: { allow: ["exec", "read"], deny: ["*image*"] },
    },
  },
}
```

請參閱設定參考：[Gateway 設定](/gateway/configuration)
