---
title: Session Pruning
summary: "Session pruning: tool-result trimming to reduce context bloat"
read_when:
  - You want to reduce LLM context growth from tool outputs
  - You are tuning agents.defaults.contextPruning
---

# 會話修剪

會話修剪會在每次呼叫大型語言模型（LLM）之前，從記憶體中的上下文中裁剪**舊的工具結果**。它**不會**重寫磁碟上的會話歷史 (`*.jsonl`)。

## 執行時機

- 當 `mode: "cache-ttl"` 啟用，且該會話最後一次 Anthropic 呼叫時間超過 `ttl` 時。
- 僅影響該請求發送給模型的訊息。
- 僅對 Anthropic API 呼叫（及 OpenRouter Anthropic 模型）有效。
- 為達最佳效果，請將 `ttl` 設定與您的模型 `cacheRetention` 政策相符（`short` = 5 分鐘，`long` = 1 小時）。
- 修剪後，TTL 時間窗會重置，後續請求會持續使用快取，直到 `ttl` 再次過期。

## 智慧預設值（Anthropic）

- **OAuth 或 setup-token** 設定檔：啟用 `cache-ttl` 修剪並將心跳設為 `1h`。
- **API key** 設定檔：啟用 `cache-ttl` 修剪，心跳設為 `30m`，並在 Anthropic 模型上預設 `cacheRetention: "short"`。
- 若您明確設定了這些值，OpenClaw 將**不會**覆寫。

## 改善專案（成本 + 快取行為）

- **為何要修剪：** Anthropic 的提示快取僅在 TTL 期間有效。若會話閒置超過 TTL，下一次請求會重新快取完整提示，除非先行裁剪。
- **降低成本的部分：** 修剪會減少 TTL 過期後首次請求的 **cacheWrite** 大小。
- **TTL 重置的重要性：** 修剪執行後，快取時間窗會重置，後續請求可重複使用新快取的提示，而非重新快取完整歷史。
- **不會做的事：** 修剪不會增加 token 數或「雙倍」成本；它只改變 TTL 過期後首次請求的快取內容。

## 可修剪內容

- 僅限 `toolResult` 訊息。
- 使用者與助理訊息**絕不**被修改。
- 最後 `keepLastAssistants` 筆助理訊息受到保護；該截止點之後的工具結果不會被修剪。
- 若助理訊息不足以建立截止點，則跳過修剪。
- 含有**圖片區塊**的工具結果會被跳過（絕不裁剪或清除）。

## 上下文視窗估算

修剪使用估算的上下文視窗（字元數 ≈ token × 4）。基礎視窗依下列順序決定：

1. `models.providers.*.models[].contextWindow` 覆寫值。
2. 模型定義中的 `contextWindow`（來自模型註冊表）。
3. 預設 `200000` token 數。

若設定了 `agents.defaults.contextTokens`，則視為解析後視窗的上限（最小值）。

## 模式

### cache-ttl

- 修剪僅在最後一次 Anthropic 呼叫時間超過 `ttl`（預設 `5m`）時執行。
- 執行時：行為與之前相同，包含軟修剪與硬清除。

## 軟修剪與硬修剪

- **軟修剪**：僅針對過大工具結果。
  - 保留開頭與結尾，插入 `...`，並附加原始大小的說明。
  - 跳過含有圖片區塊的結果。
- **硬清除**：用 `hardClear.placeholder` 取代整個工具結果。

## 工具選擇

- `tools.allow` / `tools.deny` 支援 `*` 通配符。
- 拒絕優先。
- 匹配不區分大小寫。
- 允許清單為空 => 允許所有工具。

## 與其他限制的互動

- 內建工具已會截斷自身輸出；會話修剪是額外層，防止長時間聊天累積過多工具輸出於模型上下文中。
- 壓縮是獨立的：壓縮會摘要並持久化，修剪則是每次請求的暫時行為。詳見 [/concepts/compaction](/concepts/compaction)。

## 預設值（啟用時）

- `ttl`：`"5m"`
- `keepLastAssistants`：`3`
- `softTrimRatio`：`0.3`
- `hardClearRatio`：`0.5`
- `minPrunableToolChars`：`50000`
- `softTrim`：`{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear`：`{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## 範例

預設（關閉）：

```json5
{
  agents: { defaults: { contextPruning: { mode: "off" } } },
}
```

啟用 TTL 感知修剪：

```json5
{
  agents: { defaults: { contextPruning: { mode: "cache-ttl", ttl: "5m" } } },
}
```

限制修剪至特定工具：

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

請參考設定說明：[Gateway Configuration](/gateway/configuration)
