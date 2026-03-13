---
summary: "WebSocket gateway architecture, components, and client flows"
read_when:
  - "Working on gateway protocol, clients, or transports"
title: Gateway Architecture
---

# Gateway 架構

最後更新：2026-01-22

## 概覽

- 單一長期執行的 **Gateway** 掌管所有訊息介面（WhatsApp 透過 Baileys、Telegram 透過 grammY、Slack、Discord、Signal、iMessage、WebChat）。
- 控制平面用戶端（macOS 應用程式、CLI、網頁 UI、自動化）透過 **WebSocket** 連接到 Gateway，連接的綁定主機為設定值（預設 `127.0.0.1:18789`）。
- **Nodes**（macOS/iOS/Android/無頭模式）也透過 **WebSocket** 連接，但會在 `role: node` 宣告明確的能力與指令。
- 每台主機僅有一個 Gateway；它是唯一開啟 WhatsApp 會話的地方。
- **canvas host** 由 Gateway HTTP 伺服器提供服務，路徑如下：
  - `/__openclaw__/canvas/`（代理可編輯的 HTML/CSS/JS）
  - `/__openclaw__/a2ui/`（A2UI host）
    使用與 Gateway 相同的埠號（預設 `18789`）。

## 元件與流程

### Gateway（守護程序）

- 維護供應商連線。
- 提供型別化的 WS API（請求、回應、伺服器推送事件）。
- 驗證進入的資料框架是否符合 JSON Schema。
- 發出事件如 `agent`、`chat`、`presence`、`health`、`heartbeat`、`cron`。

### 用戶端（mac 應用程式 / CLI / 網頁管理）

- 每個用戶端一個 WS 連線。
- 發送請求（`health`、`status`、`send`、`agent`、`system-presence`）。
- 訂閱事件（`tick`、`agent`、`presence`、`shutdown`）。

### Nodes（macOS / iOS / Android / 無頭模式）

- 使用 `role: node` 連接到 **相同的 WS 伺服器**。
- 在 `connect` 提供裝置身份；配對是 **基於裝置**（角色 `node`），且授權存放於裝置配對資料庫。
- 提供指令如 `canvas.*`、`camera.*`、`screen.record`、`location.get`。

協定細節：

- [Gateway 協定](/gateway/protocol)

### WebChat

- 靜態 UI，使用 Gateway WS API 取得聊天歷史並發送訊息。
- 在遠端架構中，透過與其他用戶端相同的 SSH/Tailscale 隧道連線。

## 連線生命週期（單一用戶端）

mermaid
sequenceDiagram
participant Client
participant Gateway

Client->>Gateway: req:connect
Gateway-->>Client: res (ok)
Note right of Gateway: 或回傳錯誤 + 關閉連線
Note left of Client: payload=hello-ok<br>snapshot: presence + health

Gateway-->>Client: event:presence
Gateway-->>Client: event:tick

Client->>Gateway: req:agent
Gateway-->>Client: res:agent<br>ack {runId, status:"accepted"}
Gateway-->>Client: event:agent<br>(串流中)
Gateway-->>Client: res:agent<br>final {runId, status, summary}

## Wire 協議（摘要）

- 傳輸：WebSocket，使用 JSON 負載的文字框架。
- 第一個框架**必須**是 `connect`。
- 握手完成後：
  - 請求：`{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - 事件：`{type:"event", event, payload, seq?, stateVersion?}`
- 若設定了 `OPENCLAW_GATEWAY_TOKEN`（或 `--token`），`connect.params.auth.token` 必須匹配，否則連線會關閉。
- 具副作用的方法（`send`、`agent`）需要冪等鍵以安全重試；伺服器會保留短期去重快取。
- 節點必須包含 `role: "node"` 以及 `connect` 中的能力、指令與權限。

## 配對與本地信任

- 所有 WS 用戶端（操作員與節點）在 `connect` 中包含**裝置身份**。
- 新裝置 ID 需要配對批准；Gateway 會發行**裝置 token**供後續連線使用。
- **本地**連線（迴路或 Gateway 主機的 tailnet 位址）可自動批准，保持同主機使用者體驗流暢。
- 所有連線必須簽署 `connect.challenge` 隨機數。
- 簽名負載 `v3` 同時綁定 `platform` 與 `deviceFamily`；Gateway 在重新連線時會固定配對的元資料，元資料變更需重新配對修復。
- **非本地**連線仍需明確批准。
- Gateway 認證（`gateway.auth.*`）仍適用於**所有**連線，不論本地或遠端。

詳細資訊：[Gateway 協議](/gateway/protocol)、[配對](/channels/pairing)、[安全性](/gateway/security)。

## 協議型別與程式碼生成

- 使用 TypeBox schema 定義協議。
- 從這些 schema 產生 JSON Schema。
- 從 JSON Schema 產生 Swift 模型。

## 遠端存取

- 優先：Tailscale 或 VPN。
- 替代方案：SSH 隧道。

```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
```

- 相同的握手與認證 token 適用於整個通道。
- 在遠端設定中，WS 可啟用 TLS 及選擇性釘選。

## 操作快照

- 啟動：`openclaw gateway`（前景，日誌輸出至 stdout）。
- 健康狀態：透過 WS 的 `health`（也包含於 `hello-ok` 中）。
- 監控：使用 launchd/systemd 進行自動重啟。

## 不變條件

- 每台主機僅有一個 Gateway 控制單一 Baileys 會話。
- 握手為必須；任何非 JSON 或非連線首幀皆視為強制關閉。
- 事件不會重播；用戶端必須在事件中斷時重新整理。
