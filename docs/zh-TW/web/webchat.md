---
summary: "Loopback WebChat 靜態主機與用於聊天 UI 的 Gateway WS 使用方式"
read_when:
  - 偵錯或設定 WebChat 存取時
title: "WebChat"
---

# WebChat (Gateway WebSocket UI)

狀態：macOS/iOS SwiftUI 聊天 UI 直接與 Gateway WebSocket 通訊。

## 這是什麼

- Gateway 的原生聊天 UI（無嵌入式瀏覽器且無本機靜態伺服器）。
- 使用與其他頻道相同的工作階段和路由規則。
- 確定性路由：回覆一律傳回 WebChat。

## 快速開始

1. 啟動 Gateway。
2. 開啟 WebChat UI (macOS/iOS 應用程式) 或 Control UI 的聊天分頁。
3. 確保已設定 Gateway 驗證（預設為必填，即使在 local loopback 上也是如此）。

## 運作原理（行為）

- UI 連接至 Gateway WebSocket 並使用 `chat.history`、`chat.send` 與 `chat.inject`。
- `chat.inject` 會直接將智慧助理筆記附加到對話紀錄並廣播至 UI（不執行智慧代理）。
- 歷史紀錄一律從 Gateway 獲取（不進行本機檔案監控）。
- 若無法連線至 Gateway，WebChat 將為唯讀模式。

## 遠端使用

- 遠端模式透過 SSH/Tailscale 建立 Gateway WebSocket 的通道。
- 您不需要執行獨立的 WebChat 伺服器。

## 設定參考 (WebChat)

完整設定：[設定](/gateway/configuration)

頻道選項：

- 沒有專用的 `webchat.*` 區塊。WebChat 使用下方的 Gateway 端點與驗證設定。

相關全域選項：

- `gateway.port`, `gateway.bind`: WebSocket 主機/連接埠。
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: WebSocket 驗證。
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: 遠端 Gateway 目標。
- `session.*`: 工作階段儲存與主金鑰預設值。
