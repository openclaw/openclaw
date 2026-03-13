---
summary: Health check steps for channel connectivity
read_when:
  - Diagnosing WhatsApp channel health
title: Health Checks
---

# 健康檢查 (CLI)

[[BLOCK_1]] 短指南以驗證通道連接性而不需猜測。 [[BLOCK_1]]

## 快速檢查

- `openclaw status` — 本地摘要：網關可達性/模式、更新提示、連結通道授權年齡、會話 + 最近活動。
- `openclaw status --all` — 完整的本地診斷（唯讀、彩色、安全可用於除錯）。
- `openclaw status --deep` — 也探測正在執行的網關（當支援時，按通道探測）。
- `openclaw health --json` — 向正在執行的網關請求完整的健康快照（僅限 WS；不直接使用 Baileys 插槽）。
- 將 `/status` 作為獨立訊息發送至 WhatsApp/WebChat，以獲取狀態回覆，而不需啟動代理。
- 日誌：尾隨 `/tmp/openclaw/openclaw-*.log` 並過濾 `web-heartbeat`、`web-reconnect`、`web-auto-reply`、`web-inbound`。

## 深度診斷

- 磁碟上的憑證: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (修改時間應該是最近的)。
- 會話儲存: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (路徑可以在設定中覆蓋)。計數和最近的接收者透過 `status` 顯示。
- 重新連結流程: `openclaw channels logout && openclaw channels login --verbose` 當狀態碼 409–515 或 `loggedOut` 出現在日誌中時。(注意: QR 登入流程在配對後會自動重新啟動一次，針對狀態 515。)

## 當某件事情失敗時

- `logged out` 或狀態 409–515 → 重新連結至 `openclaw channels logout` 然後 `openclaw channels login`。
- 門戶無法到達 → 啟動它：`openclaw gateway --port 18789` （如果端口忙碌，請使用 `--force`）。
- 沒有進來的訊息 → 確認連結的手機在線且發送者被允許 (`channels.whatsapp.allowFrom`)；對於群組聊天，確保允許清單 + 提及規則匹配 (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## 專用的 "health" 指令

`openclaw health --json` 向正在執行的 Gateway 請求其健康快照（CLI 中沒有直接的通道插座）。它會在可用時報告連結的憑證/身份驗證年齡、每個通道的探測摘要、會話存儲摘要以及探測持續時間。如果 Gateway 無法訪問或探測失敗/超時，則會以非零狀態退出。使用 `--timeout <ms>` 來覆蓋 10 秒的預設值。
