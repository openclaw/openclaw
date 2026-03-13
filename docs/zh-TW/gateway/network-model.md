---
summary: "How the Gateway, nodes, and canvas host connect."
read_when:
  - You want a concise view of the Gateway networking model
title: Network model
---

大多數操作都通過 Gateway (`openclaw gateway`) 流動，這是一個長時間執行的單一過程，負責擁有通道連接和 WebSocket 控制平面。

## Core rules

- 建議每個主機只使用一個 Gateway。這是唯一被允許擁有 WhatsApp Web 會話的過程。對於救援機器人或嚴格隔離的情況，請使用具有隔離設定檔和埠的多個 Gateway。詳情請參見 [Multiple gateways](/gateway/multiple-gateways)。
- 首先使用回環：Gateway WS 預設為 `ws://127.0.0.1:18789`。精靈預設會生成一個 Gateway token，即使是回環的情況下。對於 tailnet 存取，請執行 `openclaw gateway --bind tailnet --token ...`，因為非回環綁定需要 token。
- 節點可以根據需要通過 LAN、tailnet 或 SSH 連接到 Gateway WS。舊版 TCP 橋接已被棄用。
- Canvas 主機由 Gateway HTTP 伺服器提供，使用與 Gateway 相同的埠（預設為 `18789`）：
  - `/__openclaw__/canvas/`
  - `/__openclaw__/a2ui/`
    當 `gateway.auth` 被設定且 Gateway 在回環之外綁定時，這些路由會受到 Gateway 認證的保護。節點用戶端使用與其活動 WS 會話相關的節點範圍能力 URL。詳情請參見 [Gateway configuration](/gateway/configuration) (`canvasHost`, `gateway`)。
- 遠端使用通常是 SSH 隧道或 tailnet VPN。詳情請參見 [Remote access](/gateway/remote) 和 [Discovery](/gateway/discovery)。
