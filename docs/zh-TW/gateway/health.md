---
summary: "頻道連線狀態的健康檢查步驟"
read_when:
  - 診斷 WhatsApp 頻道健康狀況
title: "健康檢查"
---

# 健康檢查 (CLI)

無需猜測，快速驗證頻道連線狀態的簡短指南。

## 快速檢查

- `openclaw status` — 本地摘要：Gateway 可達性/模式、更新提示、已連結頻道的憑證效期、工作階段與近期活動。
- `openclaw status --all` — 完整的本地診斷（唯讀、彩色顯示，適合貼上用於除錯）。
- `openclaw status --deep` — 同時探測執行中的 Gateway（支援時會包含個別頻道的探測）。
- `openclaw health --json` — 向執行中的 Gateway 請求完整的健康快照（僅限 WS；無直接的 Baileys socket）。
- 在 WhatsApp/WebChat 中發送獨立訊息 `/status`，即可在不調用智慧代理的情況下獲得狀態回覆。
- 日誌：使用 `tail /tmp/openclaw/openclaw-*.log` 並篩選 `web-heartbeat`、`web-reconnect`、`web-auto-reply`、`web-inbound`。

## 深度診斷

- 磁碟上的憑證：`ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json`（修改時間 mtime 應為近期）。
- 工作階段儲存：`ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json`（路徑可在設定中覆蓋）。工作階段數量和近期收件者可透過 `status` 查閱。
- 重新連結流程：當日誌中出現狀態碼 409–515 或 `loggedOut` 時，執行 `openclaw channels logout && openclaw channels login --verbose`。（註：配對後若遇到狀態碼 515，QR 登入流程會自動重啟一次。）

## 當發生錯誤時

- `logged out` 或狀態碼 409–515 → 使用 `openclaw channels logout` 然後 `openclaw channels login` 重新連結。
- Gateway 無法連線 → 啟動它：`openclaw gateway --port 18789`（若通訊埠被佔用，請使用 `--force`）。
- 沒有收到傳入訊息 → 確認已連結的手機在線且發送者在允許名單中（`channels.whatsapp.allowFrom`）；如果是群組對話，請確保允許名單與提及規則匹配（`channels.whatsapp.groups`、`agents.list[].groupChat.mentionPatterns`）。

## 專用的「health」命令

`openclaw health --json` 會向執行中的 Gateway 請求其健康快照（CLI 不會直接建立頻道 socket）。它會報告已連結的憑證/憑證效期（如果可用）、各頻道探測摘要、工作階段儲存摘要以及探測耗時。如果 Gateway 無法連線或探測失敗/逾時，它將以非零狀態碼退出。使用 `--timeout <ms>` 可覆蓋預設的 10s 逾時。
