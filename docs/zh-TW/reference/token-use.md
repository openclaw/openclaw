---
summary: "OpenClaw 如何建構提示內容並回報權杖使用量與成本"
read_when:
  - 說明權杖使用量、成本或內容視窗時
  - 除錯內容成長或壓縮行為時
title: "權杖使用與成本"
x-i18n:
  source_path: reference/token-use.md
  source_hash: f8bfadb36b51830c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:29:24Z
---

# 權杖使用與成本

OpenClaw 追蹤的是 **權杖**，而不是字元。權杖是依模型而定，但多數 OpenAI 風格的模型在英文文字中平均約每個權杖 ~4 個字元。

## 系統提示如何建構

OpenClaw 在每次執行時都會組裝自己的系統提示。內容包含：

- 工具清單 + 簡短說明
- Skills 清單（僅中繼資料；指示會在需要時透過 `read` 載入）
- 自我更新指示
- 工作區 + 啟動檔案（`AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`、`BOOTSTRAP.md` 於新增時）。大型檔案會由 `agents.defaults.bootstrapMaxChars` 截斷（預設：20000）。
- 時間（UTC + 使用者時區）
- 回覆標籤 + 心跳行為
- 執行階段中繼資料（主機／OS／模型／思考）

請參閱 [System Prompt](/concepts/system-prompt) 以查看完整拆解。

## 內容視窗中包含哪些項目

模型接收的一切都會計入內容限制：

- 系統提示（上述所有章節）
- 對話歷史（使用者 + 助手訊息）
- 工具呼叫與工具結果
- 附件／逐字稿（圖片、音訊、檔案）
- 壓縮摘要與修剪產物
- 提供者包裝或安全標頭（不可見，但仍會計入）

如需實務層級的拆解（依注入檔案、工具、Skills 與系統提示大小），請使用 `/context list` 或 `/context detail`。另請參閱 [Context](/concepts/context)。

## 如何查看目前的權杖使用量

在聊天中使用以下指令：

- `/status` → **表情符號豐富的狀態卡**，顯示工作階段模型、內容使用量、
  上一次回覆的輸入／輸出權杖，以及 **預估成本**（僅限 API 金鑰）。
- `/usage off|tokens|full` → 將 **逐回覆使用量頁尾** 附加到每則回覆。
  - 於每個工作階段持續生效（儲存為 `responseUsage`）。
  - OAuth 驗證 **隱藏成本**（僅顯示權杖）。
- `/usage cost` → 顯示來自 OpenClaw 工作階段記錄的本機成本摘要。

其他介面：

- **TUI／Web TUI：** 支援 `/status` + `/usage`。
- **CLI：** `openclaw status --usage` 與 `openclaw channels list` 會顯示
  提供者配額視窗（非逐回覆成本）。

## 成本估算（顯示時）

成本會依你的模型定價設定估算：

```
models.providers.<provider>.models[].cost
```

上述為 `input`、`output`、`cacheRead` 與
`cacheWrite` 的 **每 100 萬權杖（USD）**。若缺少定價，OpenClaw 只會顯示權杖。OAuth 權杖
永遠不顯示美元成本。

## 快取 TTL 與修剪影響

提供者的提示快取僅在快取 TTL 視窗內適用。OpenClaw 可選擇性地執行 **cache-ttl 修剪**：當快取 TTL
到期時修剪工作階段，接著重設快取視窗，讓後續請求能重複使用
新近快取的內容，而不是重新快取完整歷史。這可在工作階段於 TTL 之後閒置時，
降低快取寫入成本。

請在 [Gateway 設定](/gateway/configuration) 中設定，並於 [Session pruning](/concepts/session-pruning) 查看行為細節。

心跳可在閒置間隔中讓快取保持 **溫熱**。若你的模型快取 TTL 為 `1h`，
將心跳間隔設在略低於該值（例如 `55m`）即可避免
重新快取完整提示，降低快取寫入成本。

對於 Anthropic API 定價，快取讀取的成本顯著低於輸入權杖，
而快取寫入則以較高倍數計費。最新費率與 TTL 倍數請參閱 Anthropic 的提示快取定價：
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### 範例：以心跳維持 1 小時快取溫熱

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

## 降低權杖壓力的技巧

- 使用 `/compact` 來摘要冗長的工作階段。
- 在工作流程中修剪大型工具輸出。
- 保持技能描述精簡（技能清單會被注入提示）。
- 在冗長、探索性的工作中優先選擇較小的模型。

請參閱 [Skills](/tools/skills) 以了解精確的技能清單額外負擔公式。
