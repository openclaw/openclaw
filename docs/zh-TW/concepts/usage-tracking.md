---
summary: "使用追蹤介面與憑證要求"
read_when:
  - 您正在連接供應商使用量/配額介面時
  - 您需要解釋使用追蹤行為或憑證要求時
title: "使用量追蹤"
---

# 使用量追蹤

## 這是什麼

- 直接從供應商的使用端點拉取其使用量/配額。
- 沒有估計費用；只有供應商回報的時間窗口。

## 顯示位置

- 聊天中的 `/status`：表情符號豐富的狀態卡，顯示工作階段代幣 + 估計費用（僅限 API key）。當可用時，供應商使用量會顯示給**目前的模型供應商**。
- 聊天中的 `/usage off|tokens|full`：每回覆的使用量頁尾（OAuth 僅顯示代幣）。
- 聊天中的 `/usage cost`：從 OpenClaw 工作階段日誌中彙總的本地費用摘要。
- CLI：`openclaw status --usage` 會列印完整的每個供應商細目。
- CLI：`openclaw channels list` 會列印相同的使用量快照以及供應商設定（使用 `--no-usage` 即可跳過）。
- macOS 選單列：「使用量」區段在「Context」下方（僅當可用時）。

## 供應商 + 憑證

- **Anthropic (Claude)**：憑證設定檔中的 OAuth 代幣。
- **GitHub Copilot**：憑證設定檔中的 OAuth 代幣。
- **Gemini CLI**：憑證設定檔中的 OAuth 代幣。
- **Antigravity**：憑證設定檔中的 OAuth 代幣。
- **OpenAI Codex**：憑證設定檔中的 OAuth 代幣（存在時使用 accountId）。
- **MiniMax**：API key（編碼方案 key；`MINIMAX_CODE_PLAN_KEY` 或 `MINIMAX_API_KEY`）；使用 5 小時編碼方案視窗。
- **z.ai**：透過環境變數/設定/憑證儲存的 API key。

如果沒有匹配的 OAuth/API 憑證，則隱藏使用量。
