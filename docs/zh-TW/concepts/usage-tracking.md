---
summary: 「使用量追蹤的呈現介面與憑證需求」
read_when:
  - 「你正在串接提供者的使用量／配額呈現介面」
  - 「你需要說明使用量追蹤的行為或身分驗證需求」
title: 「使用量追蹤」
x-i18n:
  source_path: concepts/usage-tracking.md
  source_hash: 6f6ed2a70329b2a6
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:50Z
---

# 使用量追蹤

## 內容說明

- 直接從各提供者的使用量端點擷取使用量／配額。
- 不提供成本估算；僅顯示提供者回報的時間視窗。

## 顯示位置

- 聊天中：`/status`：含豐富表情符號的狀態卡，顯示工作階段權杖＋預估成本（僅 API 金鑰）。在可用時，會顯示**目前模型提供者**的使用量。
- 聊天中：`/usage off|tokens|full`：每則回應的使用量頁尾（OAuth 僅顯示權杖）。
- 聊天中：`/usage cost`：由 OpenClaw 工作階段紀錄彙總的本地成本摘要。
- CLI：`openclaw status --usage` 會輸出完整的各提供者明細。
- CLI：`openclaw channels list` 會在提供者設定旁輸出相同的使用量快照（使用 `--no-usage` 可略過）。
- macOS 功能表列：Context 底下的「Usage」區段（僅在可用時顯示）。

## 提供者＋憑證

- **Anthropic（Claude）**：驗證設定檔中的 OAuth 權杖。
- **GitHub Copilot**：驗證設定檔中的 OAuth 權杖。
- **Gemini CLI**：驗證設定檔中的 OAuth 權杖。
- **Antigravity**：驗證設定檔中的 OAuth 權杖。
- **OpenAI Codex**：驗證設定檔中的 OAuth 權杖（存在時使用 accountId）。
- **MiniMax**：API 金鑰（程式設計方案金鑰；`MINIMAX_CODE_PLAN_KEY` 或 `MINIMAX_API_KEY`）；使用 5 小時的程式設計方案視窗。
- **z.ai**：透過 環境變數／設定／驗證儲存庫 提供的 API 金鑰。

若不存在相符的 OAuth／API 憑證，將隱藏使用量。
