---
title: Session Pruning
summary: "Session pruning: tool-result trimming to reduce context bloat"
read_when:
  - You want to reduce LLM context growth from tool outputs
  - You are tuning agents.defaults.contextPruning
---

# Session Pruning

會話修剪在每次 LLM 呼叫之前，會從記憶體上下文中修剪 **舊的工具結果**。它並不會重寫磁碟上的會話歷史 (`*.jsonl`).

## 當它執行時

- 當 `mode: "cache-ttl"` 被啟用且該會話的最後一次 Anthropic 呼叫早於 `ttl` 時。
- 只影響該請求中發送給模型的訊息。
- 僅對 Anthropic API 呼叫（以及 OpenRouter Anthropic 模型）有效。
- 為了獲得最佳結果，將 `ttl` 與您的模型 `cacheRetention` 政策相匹配 (`short` = 5m, `long` = 1h)。
- 在修剪後，TTL 窗口會重置，因此後續請求會在 `ttl` 再次過期之前保持快取。

## Smart defaults (Anthropic)

- **OAuth 或 setup-token** 設定：啟用 `cache-ttl` 修剪並將心跳設置為 `1h`。
- **API 金鑰** 設定：啟用 `cache-ttl` 修剪，將心跳設置為 `30m`，並在 Anthropic 模型上預設 `cacheRetention: "short"`。
- 如果您明確設置了這些值，OpenClaw 將 **不** 覆蓋它們。

## 這樣的改進 (成本 + 快取行為)

- **為什麼要修剪：** Anthropic 的提示快取僅在 TTL 內有效。如果會話在 TTL 之後閒置，下一個請求將重新快取完整的提示，除非你先進行修剪。
- **什麼變得更便宜：** 修剪減少了 TTL 到期後第一次請求的 **cacheWrite** 大小。
- **為什麼 TTL 重置很重要：** 一旦修剪執行，快取窗口會重置，因此後續請求可以重複使用新快取的提示，而不必再次重新快取完整的歷史記錄。
- **它不會做什麼：** 修剪不會增加 token 或“雙重”成本；它僅改變在第一次 TTL 後請求中快取的內容。

## 可以修剪什麼

- 只有 `toolResult` 訊息。
- 使用者 + 助手的訊息 **永遠** 不會被修改。
- 最後 `keepLastAssistants` 助手的訊息是受保護的；該截止日期之後的工具結果不會被修剪。
- 如果沒有足夠的助手訊息來確定截止日期，則跳過修剪。
- 包含 **圖像區塊** 的工具結果將被跳過（永遠不會被修剪/清除）。

## Context window estimation

[[BLOCK_1]]  
修剪使用估算的上下文窗口（字元 ≈ 標記 × 4）。基本窗口的解析順序如下：  
[[BLOCK_1]]

1. `models.providers.*.models[].contextWindow` 覆寫。
2. 模型定義 `contextWindow` （來自模型註冊表）。
3. 預設 `200000` token。

如果 `agents.defaults.contextTokens` 被設定，則它會被視為解決窗口的上限（最小值）。

## Mode

### cache-ttl

- 剪枝僅在最後一次 Anthropic 呼叫的時間早於 `ttl` 時執行（預設值為 `5m`）。
- 執行時：與之前相同的軟修剪 + 硬清除行為。

## 軟性修剪與硬性修剪

- **軟修剪**: 僅適用於超大工具結果。
  - 保留頭部和尾部，插入 `...`，並附上原始大小的註解。
  - 跳過包含圖像區塊的結果。
- **硬清除**: 用 `hardClear.placeholder` 替換整個工具結果。

## Tool selection

- `tools.allow` / `tools.deny` 支援 `*` 通配符。
- 拒絕勝利。
- 匹配不區分大小寫。
- 空的允許清單 => 所有工具皆可使用。

## Interaction with other limits

- 內建工具已經會截斷它們自己的輸出；會話修剪是一個額外的層級，可以防止長時間執行的聊天在模型上下文中累積過多的工具輸出。
- 壓縮是獨立的：壓縮會總結並持久化，而修剪則是每個請求的瞬時操作。請參見 [/concepts/compaction](/concepts/compaction)。

## 預設值（當啟用時）

- `ttl`: `"5m"`
- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3`
- `hardClearRatio`: `0.5`
- `minPrunableToolChars`: `50000`
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## Examples

Default (off):

```json5
{
  agents: { defaults: { contextPruning: { mode: "off" } } },
}
```

啟用 TTL 感知的修剪：

```json5
{
  agents: { defaults: { contextPruning: { mode: "cache-ttl", ttl: "5m" } } },
}
```

限制修剪到特定工具：

```json5
{
  agents: {
    defaults: {
      contextPruning: {
        mode: "cache-ttl",
        tools: { allow: ["exec", "read"], deny: ["*image*"] },
      },
    },
  },
}
```

請參閱設定參考：[Gateway Configuration](/gateway/configuration)
