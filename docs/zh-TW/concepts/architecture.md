---
summary: "WebSocket Gateway 閘道器架構、元件與客戶端流程"
read_when:
  - 在處理 Gateway 閘道器協定、客戶端或傳輸時
title: "Gateway 閘道器架構"
x-i18n:
  source_path: concepts/architecture.md
  source_hash: 14079136faa267d7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:40Z
---

# Gateway 閘道器架構

最後更新：2026-01-22

## 概覽

- 單一長時間存活的 **Gateway 閘道器** 擁有所有訊息介面（WhatsApp 透過
  Baileys、Telegram 透過 grammY、Slack、Discord、Signal、iMessage、WebChat）。
- 控制平面客戶端（macOS 應用程式、CLI、Web UI、自動化）透過 **WebSocket** 連線到
  設定的綁定位址上的 Gateway 閘道器（預設
  `127.0.0.1:18789`）。
- **Nodes**（macOS/iOS/Android/無介面）也透過 **WebSocket** 連線，但
  會宣告 `role: node` 並附上明確的能力／命令。
- 每台主機僅有一個 Gateway 閘道器；它是唯一會開啟 WhatsApp 工作階段的地方。
- **畫布主機**（預設 `18793`）提供可由代理程式編輯的 HTML 與 A2UI。

## 元件與流程

### Gateway（常駐程式）

- 維護提供者連線。
- 提供具型別的 WS API（請求、回應、伺服器推送事件）。
- 以 JSON Schema 驗證傳入的訊框。
- 發出事件，例如 `agent`、`chat`、`presence`、`health`、`heartbeat`、`cron`。

### 客戶端（mac 應用程式／CLI／Web 管理介面）

- 每個客戶端一條 WS 連線。
- 傳送請求（`health`、`status`、`send`、`agent`、`system-presence`）。
- 訂閱事件（`tick`、`agent`、`presence`、`shutdown`）。

### Nodes（macOS／iOS／Android／無介面）

- 使用 `role: node` 連線到**相同的 WS 伺服器**。
- 在 `connect` 中提供裝置身分；配對為**以裝置為基礎**（角色 `node`），
  核准狀態保存在裝置配對儲存區。
- 提供命令，例如 `canvas.*`、`camera.*`、`screen.record`、`location.get`。

協定細節：

- [Gateway protocol](/gateway/protocol)

### WebChat

- 使用 Gateway WS API 的靜態 UI，用於聊天紀錄與傳送。
- 在遠端設定中，透過與其他客戶端相同的 SSH／Tailscale 通道連線。

## 連線生命週期（單一客戶端）

```
Client                    Gateway
  |                          |
  |---- req:connect -------->|
  |<------ res (ok) ---------|   (or res error + close)
  |   (payload=hello-ok carries snapshot: presence + health)
  |                          |
  |<------ event:presence ---|
  |<------ event:tick -------|
  |                          |
  |------- req:agent ------->|
  |<------ res:agent --------|   (ack: {runId,status:"accepted"})
  |<------ event:agent ------|   (streaming)
  |<------ res:agent --------|   (final: {runId,status,summary})
  |                          |
```

## 線路協定（摘要）

- 傳輸：WebSocket，文字訊框，JSON 載荷。
- 第一個訊框**必須**是 `connect`。
- 完成交握後：
  - 請求：`{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - 事件：`{type:"event", event, payload, seq?, stateVersion?}`
- 若設定了 `OPENCLAW_GATEWAY_TOKEN`（或 `--token`），`connect.params.auth.token`
  必須相符，否則連線會關閉。
- 具副作用的方法（`send`、`agent`）需要冪等鍵以
  安全重試；伺服器會保留短期的去重快取。
- Nodes 必須在 `role: "node"` 中包含資訊，並在 `connect` 中提供能力／命令／權限。

## 配對＋本地信任

- 所有 WS 客戶端（操作人員＋ nodes）都在 `connect` 上包含**裝置身分**。
- 新的裝置 ID 需要配對核准；Gateway 閘道器會發出**裝置權杖**供後續連線使用。
- **本地**連線（loopback 或 Gateway 閘道器主機自身的 tailnet 位址）可自動核准，
  以維持同主機的順暢 UX。
- **非本地**連線必須簽署 `connect.challenge` nonce，且需要明確核准。
- Gateway 身分驗證（`gateway.auth.*`）仍適用於**所有**連線，不論本地或遠端。

詳細資訊：[Gateway protocol](/gateway/protocol)、[Pairing](/channels/pairing)、
[Security](/gateway/security)。

## 協定型別與程式碼產生

- TypeBox 結構描述定義協定。
- 由這些結構描述產生 JSON Schema。
- Swift 模型由 JSON Schema 產生。

## 遠端存取

- 首選：Tailscale 或 VPN。
- 替代方案：SSH 通道

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- 通道中套用相同的交握＋身分驗證權杖。
- 在遠端設定中可啟用 WS 的 TLS＋選用釘選。

## 營運快照

- 啟動：`openclaw gateway`（前景執行，日誌輸出至 stdout）。
- 健康狀態：透過 WS 的 `health`（亦包含於 `hello-ok`）。
- 監督：使用 launchd／systemd 進行自動重新啟動。

## 不變量

- 每台主機僅有一個 Gateway 閘道器控制單一 Baileys 工作階段。
- 交握為必要；任何非 JSON 或非 connect 的第一個訊框都會被強制關閉。
- 事件不會重播；客戶端在發生間隙時必須重新整理。
