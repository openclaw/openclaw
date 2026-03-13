---
summary: Usage tracking surfaces and credential requirements
read_when:
  - You are wiring provider usage/quota surfaces
  - You need to explain usage tracking behavior or auth requirements
title: Usage Tracking
---

# 使用量追蹤

## 什麼是使用量追蹤

- 直接從提供者的使用量端點拉取使用量/配額資料。
- 無估算成本；僅顯示提供者回報的時間區間。

## 顯示位置

- `/status` 在聊天中：帶有表情符號的狀態卡，顯示會話 token + 預估成本（僅限 API 金鑰）。當可用時，顯示**目前模型提供者**的使用量。
- `/usage off|tokens|full` 在聊天中：每次回應的使用量頁尾（OAuth 僅顯示 token）。
- `/usage cost` 在聊天中：從 OpenClaw 會話日誌彙整的本地成本摘要。
- CLI：`openclaw status --usage` 列印每個提供者的完整使用量明細。
- CLI：`openclaw channels list` 與提供者設定一起列印相同的使用量快照（使用 `--no-usage` 可跳過）。
- macOS 功能表列：Context 下的「使用量」區塊（僅在可用時顯示）。

## 提供者與憑證

- **Anthropic (Claude)**：OAuth token 存於認證設定檔中。
- **GitHub Copilot**：OAuth token 存於認證設定檔中。
- **Gemini CLI**：OAuth token 存於認證設定檔中。
- **Antigravity**：OAuth token 存於認證設定檔中。
- **OpenAI Codex**：OAuth token 存於認證設定檔中（有 accountId 時會使用）。
- **MiniMax**：API 金鑰（coding plan 金鑰；`MINIMAX_CODE_PLAN_KEY` 或 `MINIMAX_API_KEY`）；使用 5 小時的 coding plan 時間區間。
- **z.ai**：透過環境變數/設定檔/認證存取 API 金鑰。

若無相符的 OAuth/API 憑證，使用量將不會顯示。
