---
summary: "RPC adapters for external CLIs (signal-cli, legacy imsg) and gateway patterns"
read_when:
  - Adding or changing external CLI integrations
  - "Debugging RPC adapters (signal-cli, imsg)"
title: RPC Adapters
---

# RPC 適配器

OpenClaw 透過 JSON-RPC 整合外部 CLI。目前使用兩種模式。

## 模式 A：HTTP 守護程序（signal-cli）

- `signal-cli` 以守護程序方式執行，使用 HTTP 上的 JSON-RPC。
- 事件串流為 SSE (`/api/v1/events`)。
- 健康檢查探針：`/api/v1/check`。
- OpenClaw 負責 `channels.signal.autoStart=true` 的生命週期管理。

請參考 [Signal](/channels/signal) 了解設定與端點。

## 模式 B：標準輸入輸出子程序（舊版：imsg）

> **注意：** 新的 iMessage 設定請改用 [BlueBubbles](/channels/bluebubbles)。

- OpenClaw 以子程序方式啟動 `imsg rpc`（舊版 iMessage 整合）。
- JSON-RPC 透過 stdin/stdout 以換行分隔（一行一個 JSON 物件）。
- 無需 TCP 埠口，無需守護程序。

核心方法：

- `watch.subscribe` → 通知 (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list`（探針/診斷）

請參考 [iMessage](/channels/imessage) 了解舊版設定與位址 (`chat_id` 優先)。

## 適配器指引

- Gateway 負責程序管理（啟動/停止與提供者生命週期綁定）。
- 保持 RPC 用戶端的韌性：設定逾時，程序退出時自動重啟。
- 優先使用穩定 ID（例如 `chat_id`）而非顯示字串。
