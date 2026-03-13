---
summary: Usage tracking surfaces and credential requirements
read_when:
  - You are wiring provider usage/quota surfaces
  - You need to explain usage tracking behavior or auth requirements
title: Usage Tracking
---

# 使用追蹤

## 它是什麼

- 直接從提供者的使用端點提取使用量/配額。
- 沒有估算成本；僅提供者報告的時間窗口。

## 顯示位置

- `/status` 在聊天中：富含表情符號的狀態卡，包含會話token + 預估成本（僅限 API 金鑰）。提供者使用情況顯示為 **當前模型提供者**（如果可用）。
- `/usage off|tokens|full` 在聊天中：每次回應的使用情況頁腳（OAuth 僅顯示token）。
- `/usage cost` 在聊天中：從 OpenClaw 會話日誌匯總的本地成本摘要。
- CLI: `openclaw status --usage` 列印每個提供者的完整細目。
- CLI: `openclaw channels list` 列印相同的使用快照，並附上提供者設定（使用 `--no-usage` 跳過）。
- macOS 選單欄：上下文下的“使用情況”部分（僅在可用時顯示）。

## Providers + credentials

- **Anthropic (Claude)**: 認證檔案中的 OAuth token。
- **GitHub Copilot**: 認證檔案中的 OAuth token。
- **Gemini CLI**: 認證檔案中的 OAuth token。
- **Antigravity**: 認證檔案中的 OAuth token。
- **OpenAI Codex**: 認證檔案中的 OAuth token（當存在時使用 accountId）。
- **MiniMax**: API 金鑰（編碼計畫金鑰；`MINIMAX_CODE_PLAN_KEY` 或 `MINIMAX_API_KEY`）；使用 5 小時的編碼計畫窗口。
- **z.ai**: 通過 env/config/auth 存儲的 API 金鑰。

如果不存在匹配的 OAuth/API 憑證，則使用情況將被隱藏。
