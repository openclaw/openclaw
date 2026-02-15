---
summary: "Gateway、節點與 canvas host 如何連接。"
read_when:
  - 您想要了解 Gateway 網路模型的簡明視圖
title: "網路模型"
---

大多數操作都透過 Gateway (`openclaw gateway`)，這是一個負責管理頻道連接與 WebSocket 控制平面的單一長期執行程序。

## 核心規則

- 建議每個主機使用一個 Gateway。它是唯一允許管理 WhatsApp Web 工作階段的程序。對於救援機器人或嚴格隔離的需求，請執行多個具有獨立設定檔與連接埠的 Gateway。參見 [多個 Gateway](/gateway/multiple-gateways)。
- local loopback 優先：Gateway WS 預設為 `ws://127.0.0.1:18789`。精靈預設會產生 Gateway 權杖，即使是對於 local loopback。對於 tailnet 存取，請執行 `openclaw gateway --bind tailnet --token ...`，因為非 local loopback 的繫結需要權杖。
- 節點視需求透過 LAN、tailnet 或 SSH 連接到 Gateway WS。舊版的 TCP bridge 已棄用。
- Canvas host 是一個執行於 `canvasHost.port`（預設為 `18793`）的 HTTP 檔案伺服器，為節點 WebView 提供 `/__openclaw__/canvas/` 的服務。參見 [Gateway 設定](/gateway/configuration) (`canvasHost`)。
- 遠端使用通常透過 SSH 通道或 Tailscale VPN。參見 [遠端存取](/gateway/remote) 與 [裝置探索](/gateway/discovery)。
