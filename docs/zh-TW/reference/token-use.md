---
summary: How OpenClaw builds prompt context and reports token usage + costs
read_when:
  - "Explaining token usage, costs, or context windows"
  - Debugging context growth or compaction behavior
title: Token Use and Costs
---

# Token 使用與費用

OpenClaw 計算的是 **token**，而非字元。token 是依模型而定，但大多數 OpenAI 風格的模型在英文文本中平均約每個 token 佔 4 個字元。

## 系統提示詞的組成方式

OpenClaw 每次執行時都會組合自己的系統提示詞。內容包括：

- 工具清單 + 簡短描述
- 技能清單（僅元資料；指令會在需要時透過 `read` 載入）
- 自我更新指令
- 工作區與啟動檔案（新檔案時包含 `AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`、`BOOTSTRAP.md`，存在時則包含 `MEMORY.md` 和/或 `memory.md`）。大型檔案會被 `agents.defaults.bootstrapMaxChars` 截斷（預設：20000），且總啟動注入大小受 `agents.defaults.bootstrapTotalMaxChars` 限制（預設：150000）。`memory/*.md` 檔案透過記憶工具按需載入，不會自動注入。
- 時間（UTC + 使用者時區）
- 回覆標籤 + 心跳行為
- 執行時元資料（主機/作業系統/模型/思考狀態）

完整細節請參考 [系統提示詞](/concepts/system-prompt)。

## 什麼會計入上下文視窗

模型接收到的所有內容都會計入上下文限制：

- 系統提示詞（上述所有區塊）
- 對話歷史（使用者 + 助理訊息）
- 工具呼叫與工具結果
- 附件/文字記錄（圖片、音訊、檔案）
- 壓縮摘要與修剪產物
- 供應商包裝或安全標頭（不可見，但仍計入）

對於圖片，OpenClaw 會在呼叫供應商前先將文字記錄/工具圖片載荷降解析度。
可使用 `agents.defaults.imageMaxDimensionPx`（預設為 `1200`）來調整：

- 較低數值通常會減少視覺 token 使用量與載荷大小。
- 較高數值則保留更多視覺細節，適合 OCR 或介面密集的截圖。

若要實務檢視（每個注入檔案、工具、技能與系統提示詞大小），可使用 `/context list` 或 `/context detail`。詳見 [上下文](/concepts/context)。

## 如何查看目前的 token 使用量

聊天時可使用以下指令：

- `/status` → **表情符號豐富的狀態卡**，顯示會話模型、上下文使用量、最後回覆的輸入/輸出 token 數，以及 **預估費用**（僅限 API 金鑰）。
- `/usage off|tokens|full` → 在每則回覆後附加 **每回覆使用量頁尾**。
  - 會話期間持續生效（存為 `responseUsage`）。
  - OAuth 認證時 **隱藏費用**（僅顯示 token）。
- `/usage cost` → 顯示來自 OpenClaw 會話日誌的本地費用摘要。

其他介面：

- **TUI/Web TUI：** 支援 `/status` + `/usage`。
- **CLI：** `openclaw status --usage` 和 `openclaw channels list` 顯示提供者配額視窗（非每次回應成本）。

## 成本估算（顯示時）

成本是根據您的模型定價設定估算：

```
models.providers.<provider>.models[].cost
```

這些是 `input`、`output`、`cacheRead` 和 `cacheWrite` 的 **每百萬 token 美金價格**。若缺少定價，OpenClaw 僅顯示 token 數量。OAuth token 永遠不顯示美元成本。

## 快取 TTL 與修剪影響

提供者的提示快取僅在快取 TTL 時間窗內有效。OpenClaw 可選擇執行 **cache-ttl 修剪**：當快取 TTL 過期後，會修剪該會話，然後重置快取時間窗，讓後續請求能重複使用新快取的上下文，而非重新快取整個歷史。這樣能在會話閒置超過 TTL 時，降低快取寫入成本。

可在 [Gateway 設定](/gateway/configuration) 中設定，並參考 [會話修剪](/concepts/session-pruning) 了解行為細節。

Heartbeat 可在閒置期間保持快取 **活躍**。若您的模型快取 TTL 是 `1h`，將 heartbeat 間隔設定略低於此（例如 `55m`）可避免重新快取整個提示，降低快取寫入成本。

在多代理架構中，您可以維持一個共用模型設定，並透過 `agents.list[].params.cacheRetention` 針對每個代理調整快取行為。

完整的調整指南請參考 [提示快取](/reference/prompt-caching)。

以 Anthropic API 定價為例，快取讀取成本遠低於輸入 token，而快取寫入則以較高倍數計費。最新費率與 TTL 倍數請參考 Anthropic 的提示快取定價：
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### 範例：使用 heartbeat 保持 1 小時快取活躍

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
    heartbeat:
      every: "55m"
```

### 範例：混合流量與每代理快取策略

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long" # default baseline for most agents
  list:
    - id: "research"
      default: true
      heartbeat:
        every: "55m" # keep long cache warm for deep sessions
    - id: "alerts"
      params:
        cacheRetention: "none" # avoid cache writes for bursty notifications
```

`agents.list[].params` 會合併到所選模型的 `params` 之上，因此你可以只覆寫 `cacheRetention`，並繼承其他模型預設值不變。

### 範例：啟用 Anthropic 1M 上下文 Beta 標頭

Anthropic 的 1M 上下文視窗目前處於 Beta 階段。當你在支援的 Opus 或 Sonnet 模型上啟用 `context1m` 時，OpenClaw 可以注入所需的 `anthropic-beta` 值。

```yaml
agents:
  defaults:
    models:
      "anthropic/claude-opus-4-6":
        params:
          context1m: true
```

這對應到 Anthropic 的 `context-1m-2025-08-07` Beta 標頭。

此設定僅在該模型條目上設定了 `context1m: true` 時生效。

需求：憑證必須符合長上下文使用資格（API 金鑰計費，或啟用額外使用量的訂閱）。若不符合，Anthropic 會回應 `HTTP 429: rate_limit_error: Extra usage is required for long context requests`。

如果你使用 OAuth/訂閱 token (`sk-ant-oat-*`) 來驗證 Anthropic，OpenClaw 會跳過 `context-1m-*` Beta 標頭，因為 Anthropic 目前會以 HTTP 401 拒絕該組合。

## 降低 token 壓力的技巧

- 使用 `/compact` 來摘要長會話。
- 在工作流程中裁剪大型工具輸出。
- 對截圖密集的會話降低 `agents.defaults.imageMaxDimensionPx`。
- 保持技能描述簡短（技能列表會注入提示中）。
- 針對冗長、探索性工作優先使用較小模型。

請參考 [Skills](/tools/skills) 以了解精確的技能列表額外負擔公式。
