```
---
summary: "OpenClaw 如何建構提示內容 (prompt context) 並報告 Token 使用量與費用"
read_when:
  - 解釋 Token 使用量、費用或內容視窗
  - 偵錯內容增長或壓縮行為
title: "Token 使用與費用"
---

# Token 使用與費用

OpenClaw 追蹤的是 **tokens**，而非字元。Token 是模型特定的，但大多數 OpenAI 樣式模型對於英文文字平均每個 token 約為 4 個字元。

## 系統提示 (system prompt) 的建構方式

OpenClaw 在每次執行時都會組裝自己的系統提示。它包含：

- 工具列表 + 簡短描述
- Skills 列表（僅限中繼資料；指令會依需求載入，使用 `read`）
- 自我更新指令
- Workspace + 啟動檔案（`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` (新增時)，加上 `MEMORY.md` 和/或 `memory.md` (存在時)）。大型檔案會被 `agents.defaults.bootstrapMaxChars` 截斷 (預設值：20000)。`memory/*.md` 檔案透過記憶體工具依需求載入，不會自動注入。
- 時間 (UTC + 使用者時區)
- 回覆標籤 (Reply tags) + 心跳行為 (heartbeat behavior)
- 執行階段中繼資料 (host/OS/model/thinking)

請參閱 [System Prompt](/concepts/system-prompt) 中的完整細目。

## 哪些會計入內容視窗 (context window)

模型接收到的所有內容都計入內容限制：

- 系統提示 (system prompt)（上述所有區段）
- 對話歷史 (conversation history)（使用者 + 智慧代理訊息）
- 工具呼叫 (Tool calls) 和 工具結果 (tool results)
- 附件/轉錄 (Attachments/transcripts)（圖片、音訊、檔案）
- 壓縮摘要 (Compaction summaries) 和修剪產物 (pruning artifacts)
- 供應商包裝器 (Provider wrappers) 或安全標頭 (safety headers)（不可見，但仍會計數）

如需實用細目（每個注入的檔案、工具、Skills 和系統提示大小），請使用 `/context list` 或 `/context detail`。請參閱 [Context](/concepts/context)。

## 如何查看目前的 Token 使用量

在聊天中使用這些：

- `/status` → **表情符號豐富的狀態卡片**，顯示工作階段模型、內容使用量、
  上次回覆的輸入/輸出 token 以及**預估費用**（僅限 API key）。
- `/usage off|tokens|full` → 在每個回覆中附加**每個回覆的使用量頁尾**。
  - 每個工作階段持續存在（儲存為 `responseUsage`）。
  - OAuth 憑證**隱藏費用**（僅顯示 token）。
- `/usage cost` → 顯示 OpenClaw 工作階段日誌中的本地費用摘要。

其他介面：

- **TUI/Web TUI：** 支援 `/status` + `/usage`。
- **CLI：** `openclaw status --usage` 和 `openclaw channels list` 顯示
  供應商配額視窗（而非每個回覆的費用）。

## 費用估算（顯示時）

費用是根據您的模型定價設定估算的：

```
models.providers.<provider>.models[].cost
```

這些是 `input`、`output`、`cacheRead` 和 `cacheWrite` 的**每百萬 tokens 的美元價格**。如果缺少定價，OpenClaw 只會顯示 token。OAuth token 永遠不會顯示美元費用。

## 快取 TTL 和修剪影響

供應商提示快取僅在快取 TTL 視窗內適用。OpenClaw 可以選擇性地執行**快取 TTL 修剪**：一旦快取 TTL 過期，它就會修剪工作階段，然後重設快取視窗，以便後續請求可以重複使用新鮮的快取內容，而不是重新快取完整的歷史記錄。當工作階段閒置超過 TTL 時，這會降低快取寫入費用。

請在 [Gateway configuration](/gateway/configuration) 中設定它，並在 [Session pruning](/concepts/session-pruning) 中查看行為細節。

心跳機制 (Heartbeat) 可以在閒置期間保持快取**溫熱**。如果您的模型快取 TTL 為 `1h`，將心跳間隔設定為略低於該時間（例如 `55m`），可以避免重新快取完整的提示，從而降低快取寫入費用。

對於 Anthropic API 定價，快取讀取比輸入 token 便宜得多，而快取寫入則以較高的乘數計費。請參閱 Anthropic 的提示快取定價，以獲取最新費率和 TTL 乘數：
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### 範例：使用心跳機制保持 1 小時快取溫熱

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

## 降低 Token 壓力的技巧

- 使用 `/compact` 總結長工作階段。
- 修剪大型工具輸出在您的工作流程中。
- 保持 Skills 描述簡短（Skills 列表會注入到提示中）。
- 對於冗長、探索性的工作，偏好使用較小的模型。

請參閱 [Skills](/tools/skills) 以了解確切的 Skills 列表開銷公式。
```
