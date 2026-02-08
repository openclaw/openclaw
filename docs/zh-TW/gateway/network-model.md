---
summary: "Gateway、節點與 canvas 主機如何連線。"
read_when:
  - 當你想要快速了解 Gateway 的網路模型
title: "網路模型"
x-i18n:
  source_path: gateway/network-model.md
  source_hash: e3508b884757ef19
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:01Z
---

大多數操作都會流經 Gateway（`openclaw gateway`），這是一個單一、長時間執行的
處理程序，負責擁有頻道連線與 WebSocket 控制平面。

## 核心規則

- 建議每台主機僅執行一個 Gateway。它是唯一允許擁有 WhatsApp Web 工作階段的處理程序。若為救援機器人或需要嚴格隔離，可使用隔離的設定檔與連接埠來執行多個 Gateway。請參閱 [Multiple gateways](/gateway/multiple-gateways)。
- 優先使用 loopback：Gateway WS 預設為 `ws://127.0.0.1:18789`。精靈預設會產生 Gateway 權杖，即使是 loopback 亦然。若要進行 tailnet 存取，請執行 `openclaw gateway --bind tailnet --token ...`，因為非 loopback 綁定需要權杖。
- 節點可視需求透過 LAN、tailnet 或 SSH 連線至 Gateway WS。舊版 TCP 橋接已被棄用。
- Canvas 主機是在 `canvasHost.port`（預設 `18793`）上的 HTTP 檔案伺服器，為節點的 WebView 提供 `/__openclaw__/canvas/`。請參閱 [Gateway 設定](/gateway/configuration)（`canvasHost`）。
- 遠端使用通常透過 SSH 通道或 tailnet VPN。請參閱 [Remote access](/gateway/remote) 與 [Discovery](/gateway/discovery)。
