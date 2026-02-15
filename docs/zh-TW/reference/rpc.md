---
summary: "外部 CLI (signal-cli, 舊版 imsg) 的 RPC 轉接器與 Gateway 模式"
read_when:
  - 新增或變更外部 CLI 整合時
  - 偵錯 RPC 轉接器 (signal-cli, imsg) 時
title: "RPC 轉接器"
---

# RPC 轉接器

OpenClaw 透過 JSON-RPC 整合外部 CLI。目前使用兩種模式。

## 模式 A：HTTP 守護行程 (signal-cli)

- `signal-cli` 以守護行程 (daemon) 運作，透過 HTTP 進行 JSON-RPC。
- 事件串流為 SSE (`/api/v1/events`)。
- 健康檢查 (Health probe)：`/api/v1/check`。
- 當 `channels.signal.autoStart=true` 時，OpenClaw 會控管其生命週期。

請參閱 [Signal](/channels/signal) 以了解設定與端點。

## 模式 B：stdio 子程序 (舊版：imsg)

> **注意：** 對於新的 iMessage 設定，請改用 [BlueBubbles](/channels/bluebubbles)。

- OpenClaw 會啟動 `imsg rpc` 作為子程序（舊版 iMessage 整合）。
- JSON-RPC 透過 stdin/stdout 以行分隔（每行一個 JSON 物件）。
- 不需要 TCP 埠，不需要守護行程。

使用的核心方法：

- `watch.subscribe` → 通知 (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (探測/診斷)

請參閱 [iMessage](/channels/imessage) 以了解舊版設定與位址指定（優先使用 `chat_id`）。

## 轉接器指南

- Gateway 擁有該程序（啟動/停止與供應商生命週期連結）。
- 保持 RPC 用戶端的韌性：設定逾時、結束時自動重啟。
- 優先使用穩定的 ID（例如 `chat_id`），而非顯示用的字串。
