---
summary: "頻道連線的健康檢查步驟"
read_when:
  - 診斷 WhatsApp 頻道健康狀況
title: "健康檢查"
---

# 健康檢查 (CLI)

一份無需猜測即可驗證頻道連線的簡短指南。

## 快速檢查

- `openclaw status` — 本機摘要：Gateway可達性/模式、更新提示、已連結頻道憑證使用期限、工作階段 + 近期活動。
- `openclaw status --all` — 完整本機診斷（唯讀、彩色、可安全貼上以進行偵錯）。
- `openclaw status --deep` — 也會探測執行中的 Gateway（支援時會進行每個頻道的探測）。
- `openclaw health --json` — 要求執行中的 Gateway提供完整的健康快照（僅限 WS；不直接連接 Baileys 通訊端）。
- 在 WhatsApp/WebChat 中以獨立訊息傳送 `/status` 以獲取狀態回覆，而無需呼叫智慧代理。
- 日誌：追蹤 `/tmp/openclaw/openclaw-*.log` 並篩選 `web-heartbeat`、`web-reconnect`、`web-auto-reply`、`web-inbound`。

## 深度診斷

- 磁碟上的憑證：`ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime 應為近期)。
- 工作階段儲存：`ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (路徑可在設定中覆寫)。計數和近期收件人會透過 `status` 顯示。
- 重新連結流程：當日誌中出現狀態碼 409–515 或 `loggedOut` 時，執行 `openclaw channels logout && openclaw channels login --verbose`。（注意：配對後，針對狀態 515 的 QR 登入流程會自動重新啟動一次。）

## 當發生故障時

- `logged out` 或狀態 409–515 → 使用 `openclaw channels logout` 然後 `openclaw channels login` 重新連結。
- Gateway無法連線 → 啟動它：`openclaw gateway --port 18789`（如果連接埠被佔用，請使用 `--force`）。
- 沒有傳入訊息 → 確認已連結的手機在線上且寄件人被允許 (`channels.whatsapp.allowFrom`)；對於群組聊天，請確保允許清單 + 提及規則匹配 (`channels.whatsapp.groups`、`agents.list[].groupChat.mentionPatterns`)。

## 專用「health」指令

`openclaw health --json` 要求執行中的 Gateway提供其健康快照（CLI 不直接連接頻道通訊端）。它會報告已連結憑證/憑證使用期限（如果可用）、每個頻道的探測摘要、工作階段儲存摘要和探測持續時間。如果 Gateway無法連線或探測失敗/超時，它會以非零值結束。使用 `--timeout <ms>` 可覆寫 10 秒的預設值。
