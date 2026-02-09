---
summary: "工作階段修剪：修剪工具結果以減少上下文膨脹"
read_when:
  - 你想要降低工具輸出導致的 LLM 內容成長
  - 你正在調校 agents.defaults.contextPruning
---

# 工作階段修剪

工作階段修剪會在每次 LLM 呼叫前，從記憶體中的上下文修剪 **較舊的工具結果**。 它**不會**重寫磁碟上的工作階段歷史記錄（`*.jsonl`）。

## 執行時機

- 當 `mode: "cache-ttl"` 啟用，且該工作階段最後一次 Anthropic 呼叫早於 `ttl`。
- 只會影響該次請求送給模型的訊息。
- 僅對 Anthropic API 呼叫（以及 OpenRouter 的 Anthropic 模型）生效。
- 為了最佳效果，請將 `ttl` 與你的模型 `cacheControlTtl` 對齊。
- 修剪之後，TTL 視窗會重設，因此後續請求會繼續保留快取，直到 `ttl` 再次到期。

## 智慧預設（Anthropic）

- **OAuth 或 setup-token** 設定檔：啟用 `cache-ttl` 修剪，並將心跳設為 `1h`。
- **API 金鑰** 設定檔：啟用 `cache-ttl` 修剪，將心跳設為 `30m`，並在 Anthropic 模型上將預設 `cacheControlTtl` 設為 `1h`。
- 若你明確設定了上述任何值，OpenClaw **不會** 覆寫它們。

## 這能改善什麼（成本 + 快取行為）

- **為何要修剪：** Anthropic 的提示快取僅在 TTL 內適用。 如果工作階段在超過 TTL 後處於閒置狀態，下一個請求會重新快取完整提示，除非你先將其修剪。
- **哪些會更便宜：** 修剪可降低 TTL 到期後第一次請求的 **cacheWrite** 大小。
- **為何 TTL 重設很重要：** 一旦修剪執行，快取視窗會重設，因此後續請求可以重用剛快取的提示，而不必再次重新快取完整歷史。
- **它不會做什麼：** 修剪不會增加權杖數或造成「加倍」成本；它只會改變第一次 TTL 後請求中被快取的內容。

## 可被修剪的內容

- 僅限 `toolResult` 訊息。
- 使用者 + 助手訊息 **永不** 修改。
- 最近的 `keepLastAssistants` 則助手訊息會受到保護；在該切點之後的工具結果不會被修剪。
- 如果沒有足夠的助理訊息來建立截斷點，則會跳過修剪。
- 含有 **影像區塊** 的工具結果會被略過（永不修剪／清除）。

## 內容視窗估算

修剪使用估計的上下文視窗（字元 ≈ 權杖 × 4）。 基礎視窗會依下列順序解析：

1. `models.providers.*.models[].contextWindow` 覆寫。
2. 模型定義的 `contextWindow`（來自模型登錄）。
3. 預設為 `200000` 個權杖。

若設定了 `agents.defaults.contextTokens`，則視為已解析視窗的上限（取最小值）。

## 模式

### cache-ttl

- 只有在上一次 Anthropic 呼叫早於 `ttl`（預設 `5m`）時才會執行修剪。
- 執行時：與之前相同的軟修剪 + 硬清除行為。

## 軟修剪 vs 硬修剪

- **軟修剪（Soft-trim）：** 僅用於過大的工具結果。
  - 保留開頭 + 結尾，插入 `...`，並附加原始大小的說明。
  - 略過包含影像區塊的結果。
- **硬清除（Hard-clear）：** 以 `hardClear.placeholder` 取代整個工具結果。

## 工具選擇

- `tools.allow` / `tools.deny` 支援 `*` 萬用字元。
- Deny 具有最高優先權。
- 比對不區分大小寫。
- 空的允許清單 ⇒ 允許所有工具。

## 與其他限制的互動

- 內建工具已經會自行截斷輸出；工作階段修剪是額外的一層，用來防止長時間聊天在模型上下文中累積過多工具輸出。
- 壓縮是獨立的：壓縮會進行摘要並持久化，修剪則是每次請求的暫時行為。 請參閱 [/concepts/compaction](/concepts/compaction)。

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
  agent: {
    contextPruning: { mode: "off" },
  },
}
```

啟用具備 TTL 感知的修剪：

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

將修剪限制於特定工具：

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

請參閱設定參考：[Gateway Configuration](/gateway/configuration)
