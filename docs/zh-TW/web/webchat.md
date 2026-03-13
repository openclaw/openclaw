---
summary: Loopback WebChat static host and Gateway WS usage for chat UI
read_when:
  - Debugging or configuring WebChat access
title: WebChat
---

# WebChat（Gateway WebSocket UI）

狀態：macOS/iOS SwiftUI 聊天 UI 直接與 Gateway WebSocket 通訊。

## 什麼是它

- Gateway 的原生聊天 UI（無內嵌瀏覽器且無本地靜態伺服器）。
- 使用與其他通道相同的會話和路由規則。
- 確定性路由：回覆總是返回 WebChat。

## 快速開始

1. 啟動 gateway。
2. 開啟 WebChat UI（macOS/iOS 應用程式）或 Control UI 的聊天分頁。
3. 確保已設定 gateway 認證（預設必須，即使是 loopback 也需如此）。

## 運作方式（行為）

- UI 連接到 Gateway WebSocket 並使用 `chat.history`、`chat.send` 和 `chat.inject`。
- `chat.history` 為穩定性限制：Gateway 可能會截斷過長的文字欄位、省略大量的 metadata，並用 `[chat.history omitted: message too large]` 取代過大的專案。
- `chat.inject` 會直接將助理備註附加到對話記錄並廣播給 UI（不執行代理）。
- 中止的執行仍可在 UI 中保留部分助理輸出。
- Gateway 在有緩衝輸出時，會將中止的部分助理文字持久化到對話歷史，並以中止 metadata 標記該條目。
- 歷史記錄始終從 gateway 取得（不監控本地檔案）。
- 若 gateway 無法連線，WebChat 將為唯讀模式。

## Control UI 代理工具面板

- Control UI 的 `/agents` 工具面板透過 `tools.catalog` 取得執行時目錄，並將每個工具標記為 `core` 或 `plugin:<id>`（可選插件工具則標記為 `optional`）。
- 若 `tools.catalog` 不可用，面板會回退使用內建靜態清單。
- 面板可編輯設定檔與覆寫設定，但實際執行時存取仍依政策優先權（`allow`/`deny`，依代理及提供者/通道覆寫）決定。

## 遠端使用

- 遠端模式透過 SSH/Tailscale 對 gateway WebSocket 進行隧道連線。
- 不需要另外執行獨立的 WebChat 伺服器。

## 設定參考（WebChat）

完整設定：[Configuration](/gateway/configuration)

通道選項：

- 沒有專用的 `webchat.*` 區塊。WebChat 使用下方的 gateway 端點與認證設定。

相關的全域選項：

- `gateway.port`、`gateway.bind`：WebSocket 主機/連接埠。
- `gateway.auth.mode`、`gateway.auth.token`、`gateway.auth.password`：WebSocket 認證（token/密碼）。
- `gateway.auth.mode: "trusted-proxy"`：瀏覽器用戶端的反向代理認證（參見 [Trusted Proxy Auth](/gateway/trusted-proxy-auth)）。
- `gateway.remote.url`、`gateway.remote.token`、`gateway.remote.password`：遠端 gateway 目標。
- `session.*`：會話儲存與主要金鑰預設值。
