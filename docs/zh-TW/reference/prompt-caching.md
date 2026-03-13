---
title: Prompt Caching
summary: "Prompt caching knobs, merge order, provider behavior, and tuning patterns"
read_when:
  - You want to reduce prompt token costs with cache retention
  - You need per-agent cache behavior in multi-agent setups
  - You are tuning heartbeat and cache-ttl pruning together
---

# 提示快取

提示快取指的是模型提供者可以重複使用未更動的提示前綴（通常是系統/開發者指令及其他穩定的上下文）於多輪對話中，而不必每次都重新處理。第一次匹配的請求會寫入快取 token (`cacheWrite`)，後續匹配的請求則可以讀取這些快取 token (`cacheRead`)。

重要性：降低 token 成本、加快回應速度，並為長時間執行的會話帶來更可預測的效能。若沒有快取，重複的提示每輪都會支付完整的提示成本，即使大部分輸入未改變。

本頁涵蓋所有影響提示重用與 token 成本的快取相關設定。

關於 Anthropic 價格詳情，請參考：
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

## 主要設定

### `cacheRetention`（模型與每個代理）

設定模型參數上的快取保留：

```yaml
agents:
  defaults:
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "short" # none | short | long
```

每個代理的覆寫設定：

```yaml
agents:
  list:
    - id: "alerts"
      params:
        cacheRetention: "none"
```

設定合併順序：

1. `agents.defaults.models["provider/model"].params`
2. `agents.list[].params`（匹配代理 ID；以鍵值覆寫）

### 舊版 `cacheControlTtl`

舊版數值仍被接受並映射：

- `5m` -> `short`
- `1h` -> `long`

新設定建議使用 `cacheRetention`。

### `contextPruning.mode: "cache-ttl"`

在快取 TTL 期限後，修剪舊的工具結果上下文，避免閒置後的請求重新快取過大的歷史資料。

```yaml
agents:
  defaults:
    contextPruning:
      mode: "cache-ttl"
      ttl: "1h"
```

完整行為請參考[會話修剪](/concepts/session-pruning)。

### 心跳保溫

心跳機制可保持快取視窗活躍，減少閒置間隔後重複的快取寫入。

```yaml
agents:
  defaults:
    heartbeat:
      every: "55m"
```

支援在 `agents.list[].heartbeat` 進行每個代理的心跳。

## 供應商行為

### Anthropic（直接 API）

- 支援 `cacheRetention`。
- 使用 Anthropic API 金鑰認證設定時，OpenClaw 會在未設定時為 Anthropic 模型參考預設 `cacheRetention: "short"`。

### Amazon Bedrock

- Anthropic Claude 模型參考 (`amazon-bedrock/*anthropic.claude*`) 支援明確的 `cacheRetention` 直通。
- 非 Anthropic Bedrock 模型在執行時強制使用 `cacheRetention: "none"`。

### OpenRouter Anthropic 模型

對於 `openrouter/anthropic/*` 模型參考，OpenClaw 會在系統/開發者提示區塊注入 Anthropic `cache_control`，以提升提示快取的重用率。

### 其他供應商

如果供應商不支援此快取模式，`cacheRetention` 將不會生效。

## 調整模式

### 混合流量（推薦預設）

在主要代理保持長期基線，並在突發通知代理上關閉快取：

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
  list:
    - id: "research"
      default: true
      heartbeat:
        every: "55m"
    - id: "alerts"
      params:
        cacheRetention: "none"
```

### 成本優先基線

- 設定基線 `cacheRetention: "short"`。
- 啟用 `contextPruning.mode: "cache-ttl"`。
- 僅對受益於熱快取的代理，將心跳維持在 TTL 以下。

## 快取診斷

OpenClaw 提供專用的快取追蹤診斷，用於嵌入式代理執行。

### `diagnostics.cacheTrace` 設定

```yaml
diagnostics:
  cacheTrace:
    enabled: true
    filePath: "~/.openclaw/logs/cache-trace.jsonl" # optional
    includeMessages: false # default true
    includePrompt: false # default true
    includeSystem: false # default true
```

預設值：

- `filePath`: `$OPENCLAW_STATE_DIR/logs/cache-trace.jsonl`
- `includeMessages`: `true`
- `includePrompt`: `true`
- `includeSystem`: `true`

### 環境切換（一次性除錯）

- `OPENCLAW_CACHE_TRACE=1` 啟用快取追蹤。
- `OPENCLAW_CACHE_TRACE_FILE=/path/to/cache-trace.jsonl` 覆寫輸出路徑。
- `OPENCLAW_CACHE_TRACE_MESSAGES=0|1` 切換完整訊息負載擷取。
- `OPENCLAW_CACHE_TRACE_PROMPT=0|1` 切換提示文字擷取。
- `OPENCLAW_CACHE_TRACE_SYSTEM=0|1` 切換系統提示擷取。

### 檢查專案

- 快取追蹤事件為 JSONL 格式，包含分階段快照，如 `session:loaded`、`prompt:before`、`stream:context` 和 `session:after`。
- 每回合快取 token 影響可在一般使用介面中透過 `cacheRead` 和 `cacheWrite` 查看（例如 `/usage full` 及會話使用摘要）。

## 快速故障排除

- 大多數回合出現高 `cacheWrite`：檢查是否有易變的系統提示輸入，並確認模型/提供者支援您的快取設定。
- `cacheRetention` 無效：確認模型金鑰與 `agents.defaults.models["provider/model"]` 相符。
- Bedrock Nova/Mistral 請求搭配快取設定：預期執行時強制為 `none`。

相關文件：

- [Anthropic](/providers/anthropic)
- [Token Use and Costs](/reference/token-use)
- [Session Pruning](/concepts/session-pruning)
- [Gateway Configuration Reference](/gateway/configuration-reference)
