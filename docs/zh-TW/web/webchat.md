---
summary: "WebChat 靜態主機與 Gateway WebSocket 用於聊天使用者介面"
read_when:
  - 偵錯或設定 WebChat 存取
title: "WebChat"
---

# WebChat (Gateway WebSocket 使用者介面)

狀態：macOS/iOS SwiftUI 聊天使用者介面直接與 Gateway WebSocket 進行通訊。

## 這是什麼

- 一個用於 Gateway 的原生聊天使用者介面 (沒有內嵌瀏覽器，也沒有本地靜態伺服器)。
- 使用與其他頻道相同的工作階段和路由規則。
- 確定性路由：回覆總是返回 WebChat。

## 快速開始

1. 啟動 Gateway。
2. 打開 WebChat 使用者介面 (macOS/iOS 應用程式) 或 Control UI 聊天分頁。
3. 確保 Gateway 憑證已設定 (預設需要，即使在 local loopback 也一樣)。

## 運作方式 (行為)

- 使用者介面連接到 Gateway WebSocket 並使用 `chat.history`、`chat.send` 和 `chat.inject`。
- `chat.inject` 將智慧代理註釋直接附加到對話紀錄，並將其廣播到使用者介面 (沒有智慧代理執行)。
- 對話紀錄總是從 Gateway 擷取 (沒有本地檔案監控)。
- 如果 Gateway 無法連接，WebChat 將是唯讀的。

## 遠端使用

- 遠端模式透過 SSH/Tailscale 通道 Gateway WebSocket。
- 您無需運行單獨的 WebChat 伺服器。

## 設定參考 (WebChat)

完整設定：[設定](/gateway/configuration)

頻道選項：

- 沒有專用的 `webchat.*` 區塊。WebChat 使用下面的 Gateway 端點 + 憑證設定。

相關全域選項：

- `gateway.port`、`gateway.bind`：WebSocket 主機/埠。
- `gateway.auth.mode`、`gateway.auth.token`、`gateway.auth.password`：WebSocket 憑證。
- `gateway.remote.url`、`gateway.remote.token`、`gateway.remote.password`：遠端 Gateway 目標。
- `session.*`：工作階段儲存和主要鍵預設值。
