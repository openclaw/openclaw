---
summary: "用於檢查頻道連線狀態的健康檢查步驟"
read_when:
  - 診斷 WhatsApp 頻道健康狀態
title: "健康檢查"
---

# 健康檢查（CLI）

不靠猜測即可驗證頻道連線狀態的簡短指南。

## 快速檢查

- `openclaw status` — 本機摘要：Gateway 閘道器 可達性／模式、更新提示、已連結頻道的身分驗證年齡、工作階段與近期活動。
- `openclaw status --all` — 完整本機診斷（唯讀、彩色、可安全貼上以供除錯）。
- `openclaw status --deep` — 也會探測正在執行的 Gateway 閘道器（在支援時進行每個頻道的探測）。
- `openclaw health --json` — 向正在執行的 Gateway 閘道器 要求完整健康快照（僅 WS；不直接連線 Baileys socket）。
- 在 WhatsApp／WebChat 中以獨立訊息傳送 `/status`，即可在不呼叫代理程式的情況下取得狀態回覆。
- 記錄：tail `/tmp/openclaw/openclaw-*.log`，並篩選 `web-heartbeat`、`web-reconnect`、`web-auto-reply`、`web-inbound`。

## 深度診斷

- 磁碟上的認證：`ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json`（mtime 應為近期）。
- 工作階段儲存區：`ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json`（路徑可在設定中覆寫）。數量與近期收件者會透過 `status` 顯示。 50. 透過 `status` 顯示計數與近期收件者。
- 1. 重新連結流程：當日誌中出現狀態碼 409–515 或 `loggedOut` 時，執行 `openclaw channels logout && openclaw channels login --verbose`。 2.（注意：QR 登入流程在配對後，若遇到狀態 515 會自動重新啟動一次。）

## 發生失敗時

- `logged out` 或狀態 409–515 → 使用 `openclaw channels logout` 重新連結，接著 `openclaw channels login`。
- Gateway 閘道器 無法連線 → 啟動它：`openclaw gateway --port 18789`（若連接埠忙碌，使用 `--force`）。
- 沒有傳入訊息 → 確認已連結的手機在線，且寄件者在允許清單中（`channels.whatsapp.allowFrom`）；群組聊天請確認允許清單與提及規則相符（`channels.whatsapp.groups`、`agents.list[].groupChat.mentionPatterns`）。

## 專用「health」指令

`openclaw health --json` 會向正在執行的 Gateway 閘道器 要求其健康快照（CLI 不會直接連線任何頻道 socket）。它會回報可用時的已連結認證／身分驗證年齡、各頻道探測摘要、工作階段儲存區摘要，以及探測耗時。若 Gateway 閘道器 無法連線或探測失敗／逾時，則以非零碼結束。使用 `--timeout <ms>` 可覆寫預設的 10 秒。 3. 在可用時回報已連結的憑證/授權年齡、各通道探測摘要、工作階段儲存摘要，以及探測耗時。 4. 若 Gateway 無法連線或探測失敗/逾時，將以非零狀態碼結束。 5. 使用 `--timeout <ms>` 覆寫預設的 10 秒。
