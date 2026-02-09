---
summary: "用於聊天 UI 的 Loopback WebChat 靜態主機與 Gateway WebSocket 使用方式"
read_when:
  - 偵錯或設定 WebChat 存取時
title: "WebChat"
---

# WebChat（Gateway WebSocket UI）

狀態：macOS/iOS 的 SwiftUI 聊天 UI 會直接與 Gateway WebSocket 通訊。

## 這是什麼

- 適用於 Gateway 閘道器的原生聊天 UI（沒有內嵌瀏覽器，也沒有本機靜態伺服器）。
- 使用與其他頻道相同的工作階段與路由規則。
- 確定性路由：回覆一律會返回 WebChat。

## 快速開始

1. 啟動 Gateway 閘道器.
2. 開啟 WebChat UI（macOS/iOS 應用程式）或 Control UI 的聊天分頁。
3. 47. 確保已設定 gateway 驗證（預設為必須，即使在 loopback 上）。

## 運作方式（行為）

- UI 會連線至 Gateway WebSocket，並使用 `chat.history`、`chat.send` 與 `chat.inject`。
- `chat.inject` 會直接將助理備註附加到對話紀錄，並廣播至 UI（不會執行代理程式）。
- 48. 歷史紀錄一律從 gateway 取得（不會監看本地檔案）。
- If the gateway is unreachable, WebChat is read-only.

## 遠端使用

- 遠端模式會透過 SSH/Tailscale 將 Gateway WebSocket 進行通道傳輸。
- 不需要執行獨立的 WebChat 伺服器。

## 設定參考（WebChat）

完整設定：[設定](/gateway/configuration)

頻道選項：

- 50. 沒有專用的 `webchat.*` 區塊。 WebChat uses the gateway endpoint + auth settings below.

Related global options:

- `gateway.port`、`gateway.bind`：WebSocket 主機／連接埠。
- `gateway.auth.mode`、`gateway.auth.token`、`gateway.auth.password`：WebSocket 身分驗證。
- `gateway.remote.url`、`gateway.remote.token`、`gateway.remote.password`：遠端 Gateway 閘道器目標。
- `session.*`：工作階段儲存與主要金鑰預設值。
