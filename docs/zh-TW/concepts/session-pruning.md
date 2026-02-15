---
title: "工作階段修剪"
summary: "工作階段修剪：工具結果裁切以減少上下文膨脹"
read_when:
  - 您想要減少 LLM 上下文因工具輸出而增長
  - 您正在調整 agents.defaults.contextPruning
---

# 工作階段修剪

工作階段修剪會在每次 LLM 呼叫前，從記憶體上下文裁切**舊的工具結果**。它**不會**重寫磁碟上的工作階段歷史 (`*.jsonl`)。

## 執行時機

- 當 `mode: "cache-ttl"` 啟用且工作階段的最後一次 Anthropic 呼叫早於 `ttl` 時。
- 僅影響該請求發送給模型的訊息。
- 僅對 Anthropic API 呼叫（以及 OpenRouter Anthropic 模型）有效。
- 為獲得最佳結果，請將 `ttl` 與您的模型 `cacheControlTtl` 相符。
- 修剪後，TTL 視窗會重置，因此後續請求會保留快取直到 `ttl` 再次過期。

## 智慧預設值 (Anthropic)

- **OAuth 或 setup-token** 設定檔：啟用 `cache-ttl` 修剪並將心跳設定為 `1h`。
- **API key** 設定檔：啟用 `cache-ttl` 修剪，將心跳設定為 `30m`，並將 Anthropic 模型上的 `cacheControlTtl` 預設為 `1h`。
- 如果您明確設定了這些值中的任何一個，OpenClaw 將**不會**覆蓋它們。

## 改進了什麼（成本 + 快取行為）

- **為何修剪：** Anthropic 提示快取僅在 TTL 內適用。如果工作階段閒置超過 TTL，則下一個請求會重新快取完整提示，除非您先將其裁切。
- **什麼變得更便宜：** 修剪會減少 TTL 過期後首次請求的 **cacheWrite** 大小。
- **為何 TTL 重置很重要：** 一旦修剪執行，快取視窗會重置，因此後續請求可以重複使用新鮮快取的提示，而不是再次重新快取完整歷史紀錄。
- **它不做什麼：** 修剪不會增加 token 或「雙倍」成本；它只會改變在 TTL 後首次請求中快取的內容。

## 可以修剪的內容

- 僅限 `toolResult` 訊息。
- 使用者 + 助理訊息**永遠不會**被修改。
- 最後 `keepLastAssistants` 個助理訊息受到保護；該截止點之後的工具結果不會被修剪。
- 如果沒有足夠的助理訊息來建立截止點，則跳過修剪。
- 包含**圖片區塊**的工具結果會被跳過（永遠不會被裁切/清除）。

## 上下文視窗估計

修剪使用估計的上下文視窗（字元 ≈ token × 4）。基礎視窗按以下順序解析：

1. `models.providers.*.models[].contextWindow` 覆寫。
2. 模型定義 `contextWindow`（來自模型註冊表）。
3. 預設 `200000` token。

如果設定了 `agents.defaults.contextTokens`，它將被視為已解析視窗的上限（最小值）。

## 模式

### cache-ttl

- 只有當上次 Anthropic 呼叫早於 `ttl`（預設 `5m`）時，修剪才會執行。
- 執行時：與之前相同的軟裁切 + 硬清除行為。

## 軟修剪與硬修剪

- **軟裁切**：僅適用於過大的工具結果。
  - 保留開頭 + 結尾，插入 `...`，並附加帶有原始大小的註釋。
  - 跳過包含圖片區塊的結果。
- **硬清除**：將整個工具結果替換為 `hardClear.placeholder`。

## 工具選擇

- `tools.allow` / `tools.deny` 支援 `*` 萬用字元。
- 拒絕優先。
- 比對不區分大小寫。
- 空白允許列表 => 允許所有工具。

## 與其他限制的互動

- 內建工具已經會截斷其自身的輸出；工作階段修剪是額外的一層，可防止長時間執行的聊天在模型上下文中累積過多的工具輸出。
- 壓縮是獨立的：壓縮會進行摘要和持久化，而修剪則是每個請求的暫時性行為。請參閱 [/concepts/compaction](/concepts/compaction)。

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

啟用支援 TTL 的修剪：

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

將修剪限制為特定工具：

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
