---
summary: "外部 CLI (signal-cli, 舊版 imsg) 和 Gateway 模式的 RPC 轉接器"
read_when:
  - 新增或變更外部 CLI 整合
  - 對 RPC 轉接器 (signal-cli, imsg) 進行偵錯
title: "RPC 轉接器"
---

# RPC 轉接器

OpenClaw 透過 JSON-RPC 整合外部 CLI。目前使用兩種模式。

## 模式 A：HTTP 常駐程式 (signal-cli)

- `signal-cli` 作為常駐程式執行，透過 HTTP 提供 JSON-RPC 服務。
- 事件串流為 SSE (`/api/v1/events`)。
- 健康狀況探測：`/api/v1/check`。
- 當 `channels.signal.autoStart=true` 時，OpenClaw 擁有其生命週期。

有關設定和端點，請參閱 [Signal](/channels/signal)。

## 模式 B：stdio 子程序 (舊版: imsg)

> **注意：** 對於新的 iMessage 設定，請改用 [BlueBubbles](/channels/bluebubbles)。

- OpenClaw 啟動 `imsg rpc` 作為子程序 (舊版 iMessage 整合)。
- JSON-RPC 透過標準輸入/輸出進行行分隔 (每行一個 JSON 物件)。
- 無需 TCP 連接埠，也無需常駐程式。

使用的核心方法：

- `watch.subscribe` → 通知 (`method: "訊息"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (探測/診斷)

有關舊版設定和定址 (推薦使用 `chat_id`)，請參閱 [iMessage](/channels/imessage)。

## 轉接器指南

- Gateway 擁有程序 (啟動/停止與供應商生命週期相關)。
- 保持 RPC 用戶端彈性：逾時、退出後重新啟動。
- 優先使用穩定的 ID (例如 `chat_id`)，而非顯示字串。
