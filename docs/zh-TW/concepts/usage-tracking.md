---
summary: "使用量追蹤介面與憑證需求"
read_when:
  - 當你在串接供應商使用量/配額介面時
  - 當你需要說明使用量追蹤行為或驗證需求時
title: "使用量追蹤"
---

# 使用量追蹤

## 這是什麼

- 直接從供應商的使用量端點獲取使用量/配額。
- 不提供估算成本；僅顯示供應商回報的時間窗口。

## 顯示位置

- 聊天中的 `/status`：豐富表情符號的狀態卡片，包含工作階段 tokens + 估算成本（僅限 API key）。當可用時，會顯示**目前模型供應商**的使用量。
- 聊天中的 `/usage off|tokens|full`：每則回應的使用量頁尾（OAuth 僅顯示 tokens）。
- 聊天中的 `/usage cost`：彙整自 OpenClaw 工作階段日誌的本地成本摘要。
- CLI：`openclaw status --usage` 列印完整的各供應商明細。
- CLI：`openclaw channels list` 在供應商設定旁列印相同的使用量快照（使用 `--no-usage` 略過）。
- macOS 選單列：Context 下的「Usage」區段（僅在可用時顯示）。

## 供應商與憑證

- **Anthropic (Claude)**：驗證設定檔中的 OAuth tokens。
- **GitHub Copilot**：驗證設定檔中的 OAuth tokens。
- **Gemini CLI**：驗證設定檔中的 OAuth tokens。
- **Antigravity**：驗證設定檔中的 OAuth tokens。
- **OpenAI Codex**：驗證設定檔中的 OAuth tokens（若存在則使用 accountId）。
- **MiniMax**：API key（程式碼方案金鑰；`MINIMAX_CODE_PLAN_KEY` 或 `MINIMAX_API_KEY`）；使用 5 小時程式碼方案窗口。
- **z.ai**：透過環境變數/設定/驗證儲存庫提供的 API key。

若不存在匹配的 OAuth/API 憑證，則會隱藏使用量。
