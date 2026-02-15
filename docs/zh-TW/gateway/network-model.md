---
summary: "Gateway、節點和畫布主機如何連接。"
read_when:
  - 您希望簡潔地了解 Gateway網路模型
title: "網路模型"
---

大多數操作都透過 Gateway (`openclaw gateway`) 進行，這是一個單一且長期執行的處理程序，負責管理頻道連接以及 WebSocket 控制平面。

## 核心規則

- 建議每台主機運行一個 Gateway。它是唯一允許擁有 WhatsApp Web 工作階段的處理程序。對於救援機器人或嚴格沙箱隔離的應用，請使用獨立的設定檔和連接埠來執行多個 Gateway。請參閱 [多個 Gateway](/gateway/multiple-gateways)。
- local loopback 優先：Gateway WS 預設為 `ws://127.0.0.1:18789`。精靈預設會產生一個 Gateway權杖，即使是對於 local loopback 也是如此。對於 Tailscale 網路存取，請執行 `openclaw gateway --bind tailnet --token ...`，因為非 local loopback 綁定需要權杖。
- 節點根據需要透過區域網路、Tailscale 網路或 SSH 連接到 Gateway WS。傳統的 TCP 橋接已棄用。
- 畫布主機是一個 HTTP 檔案伺服器，運行在 `canvasHost.port` (預設 `18793`) 上，提供 `/__openclaw__/canvas/` 給節點 WebViews 使用。請參閱 [Gateway設定](/gateway/configuration) (`canvasHost`)。
- 遠端使用通常是 SSH 通道或 Tailscale VPN。請參閱 [遠端存取](/gateway/remote) 和 [裝置探索](/gateway/discovery)。
