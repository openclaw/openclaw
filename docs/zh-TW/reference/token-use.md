---
summary: "OpenClaw 如何構建提示詞上下文以及回報 Token 使用量與成本"
read_when:
  - 解釋 Token 使用量、成本或上下文視窗時
  - 除錯上下文增長或壓縮行為時
title: "Token 使用與成本"
---

# Token 使用與成本

OpenClaw 追蹤的是 **Token**，而非字元。Token 依模型而異，但大多數 OpenAI 風格的模型對於英文文本平均每個 Token 約為 4 個字元。

## 系統提示詞如何構建

OpenClaw 在每次執行時都會組裝自己的系統提示詞。其中包含：

- 工具列表 + 簡短描述
- Skills 列表（僅包含中繼資料；指令會依據需求透過 `read` 載入）
- 自我更新指令
- 工作區 + 引導檔案（`AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`，新建時包含 `BOOTSTRAP.md`，存在時包含 `MEMORY.md` 和/或 `memory.md`）。大型檔案會依照 `agents.defaults.bootstrapMaxChars`（預設：20000）進行截斷。`memory/*.md` 檔案會透過記憶體工具依需求載入，不會自動插入。
- 時間（UTC + 使用者時區）
- 回覆標籤 + heartbeat 行為
- 執行階段中繼資料（主機/作業系統/模型/思考過程）

請參閱[系統提示詞](/concepts/system-prompt)中的完整分析。

## 什麼會被計入上下文視窗

模型接收的所有內容都會計入上下文限制：

- 系統提示詞（上述所有部分）
- 對話歷史（使用者 + 智慧代理訊息）
- 工具呼叫與工具結果
- 附件/逐字稿（圖片、音訊、檔案）
- 壓縮摘要與修剪產物
- 供應商封裝或安全標頭（不可見，但仍會計算）

如需實際分析（依據插入的檔案、工具、Skills 和系統提示詞大小），請使用 `/context list` 或 `/context detail`。請參閱[上下文](/concepts/context)。

## 如何查看目前的 Token 使用量

在聊天中使用以下指令：

- `/status` → **包含豐富圖示的狀態卡片**，顯示工作階段模型、上下文使用量、上次回覆的輸入/輸出 Token，以及**預估成本**（僅限 API 金鑰）。
- `/usage off|tokens|full` → 在每則回覆後方附加**單次回覆的使用量頁尾**。
  - 每個工作階段都會持續有效（儲存為 `responseUsage`）。
  - OAuth 驗證會**隱藏成本**（僅顯示 Token）。
- `/usage cost` → 從 OpenClaw 工作階段日誌顯示本地成本摘要。

其他介面：

- **TUI/Web TUI：** 支援 `/status` 與 `/usage`。
- **CLI：** `openclaw status --usage` 與 `openclaw channels list` 會顯示供應商額度視窗（而非單次回覆成本）。

## 成本估算（顯示時）

成本是根據您的模型定價設定進行估算的：

```
models.providers.<provider>.models[].cost
```

這些是 `input`、`output`、`cacheRead` 和 `cacheWrite` **每 100 萬個 Token 的美金（USD）**價格。如果缺少定價資訊，OpenClaw 僅顯示 Token。OAuth 驗證永遠不會顯示美金成本。

## 快取 TTL 與修剪影響

供應商提示詞快取僅在快取 TTL 視窗內有效。OpenClaw 可以選擇執行 **cache-ttl 修剪**：一旦快取 TTL 到期，它會修剪工作階段並重置快取視窗，以便後續請求可以重複使用最新快取的上下文，而不是重新快取整個歷史記錄。這可以在工作階段閒置超過 TTL 時降低快取寫入成本。

請在 [Gateway 設定](/gateway/configuration)中進行設定，並在[工作階段修剪](/concepts/session-pruning)中查看行為詳情。

Heartbeat 可以在閒置期間保持快取**「熱度」**。如果您的模型快取 TTL 為 `1h`，將 heartbeat 間隔設定為略低於該值（例如 `55m`）可以避免重新快取完整提示詞，從而降低快取寫入成本。

對於 Anthropic API 定價，快取讀取（cache reads）明顯比輸入 Token 便宜，而快取寫入（cache writes）則以較高的倍數計費。請參閱 Anthropic 的提示詞快取定價以獲取最新費率和 TTL 倍數：
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### 範例：使用 heartbeat 保持 1 小時快取熱度

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

## 減輕 Token 壓力的技巧

- 使用 `/compact` 摘要冗長的工作階段。
- 在您的工作流程中修剪大型工具輸出。
- 保持 Skills 描述簡短（Skills 列表會被插入提示詞中）。
- 對於冗長、探索性的工作，優先選擇較小的模型。

請參閱 [Skills](/tools/skills) 以獲取精確的 Skills 列表開銷公式。
