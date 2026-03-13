---
summary: "WebSocket gateway architecture, components, and client flows"
read_when:
  - "Working on gateway protocol, clients, or transports"
title: Gateway Architecture
---

# Gateway 架構

最後更新：2026-01-22

## 概述

- 一個長期執行的 **Gateway** 擁有所有的消息介面（透過 Baileys 的 WhatsApp、透過 grammY 的 Telegram、Slack、Discord、Signal、iMessage、WebChat）。
- 控制平面用戶端（macOS 應用程式、CLI、網頁 UI、自動化）透過 **WebSocket** 連接到 Gateway，使用設定的綁定主機（預設 `127.0.0.1:18789`）。
- **Nodes**（macOS/iOS/Android/headless）也透過 **WebSocket** 連接，但會明確聲明 `role: node` 及其功能/指令。
- 每個主機僅有一個 Gateway；它是唯一可以開啟 WhatsApp 會話的地方。
- **canvas host** 由 Gateway HTTP 伺服器提供服務，位於：
  - `/__openclaw__/canvas/`（可由代理編輯的 HTML/CSS/JS）
  - `/__openclaw__/a2ui/`（A2UI 主機）
    它使用與 Gateway 相同的埠（預設 `18789`）。

## Components and flows

### Gateway (守護進程)

- 維護提供者連接。
- 提供一個類型化的 WS API（請求、回應、伺服器推送事件）。
- 根據 JSON Schema 驗證進來的框架。
- 發出事件，如 `agent`、`chat`、`presence`、`health`、`heartbeat`、`cron`。

### Clients (mac 應用程式 / CLI / 網頁管理)

- 每個用戶端一個 WS 連接。
- 發送請求 (`health`, `status`, `send`, `agent`, `system-presence`)。
- 訂閱事件 (`tick`, `agent`, `presence`, `shutdown`)。

### 節點 (macOS / iOS / Android / 無頭)

- 使用 `role: node` 連接到 **相同的 WS 伺服器**。
- 在 `connect` 中提供設備身份；配對是 **基於設備** 的（角色 `node`），且批准存儲在設備配對庫中。
- 暴露命令如 `canvas.*`、`camera.*`、`screen.record`、`location.get`。

[[BLOCK_1]]  
Protocol details:  
[[INLINE_1]]

- [Gateway protocol](/gateway/protocol)

### WebChat

- 靜態 UI 使用 Gateway WS API 來獲取聊天歷史紀錄並發送訊息。
- 在遠端設置中，通過與其他用戶端相同的 SSH/Tailscale 隧道進行連接。

## 連線生命週期（單一用戶端）

mermaid
sequenceDiagram
participant Client
participant Gateway

Client->>Gateway: req:connect  
 Gateway-->>Client: res (ok)  
 Note right of Gateway: 或 res 錯誤 + 關閉  
 Note left of Client: payload=hello-ok<br>snapshot: presence + health

Gateway-->>Client: event:presence  
 Gateway-->>Client: event:tick

Client->>Gateway: req:agent
Gateway-->>Client: res:agent<br>ack {runId, status:"accepted"}
Gateway-->>Client: event:agent<br>(streaming)
Gateway-->>Client: res:agent<br>final {runId, status, summary}

## Wire protocol (summary)

- 傳輸：WebSocket，使用帶有 JSON 負載的文本框架。
- 第一個框架 **必須** 是 `connect`。
- 握手後：
  - 請求：`{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - 事件：`{type:"event", event, payload, seq?, stateVersion?}`
- 如果 `OPENCLAW_GATEWAY_TOKEN`（或 `--token`）被設置，`connect.params.auth.token` 必須匹配，否則連接將關閉。
- 對於有副作用的方法 (`send`, `agent`)，需要使用冪等性鍵以安全地重試；伺服器會保持一個短期的去重快取。
- 節點必須包含 `role: "node"` 以及 `connect` 中的能力/命令/權限。

## 配對 + 本地信任

- 所有 WS 用戶端（操作員 + 節點）在 `connect` 上包含一個 **設備身份**。
- 新的設備 ID 需要配對批准；閘道會發出一個 **設備token** 以供後續連接使用。
- **本地** 連接（回環或閘道主機的自有 tailnet 地址）可以自動批准，以保持同主機的使用體驗流暢。
- 所有連接必須簽署 `connect.challenge` 隨機數。
- 簽名有效載荷 `v3` 也綁定 `platform` + `deviceFamily`；閘道在重新連接時會固定配對的元數據，並要求對元數據變更進行修復配對。
- **非本地** 連接仍然需要明確批准。
- 閘道身份驗證 (`gateway.auth.*`) 仍然適用於 **所有** 連接，無論是本地還是遠程。

細節: [閘道協議](/gateway/protocol)、[配對](/channels/pairing)、[安全性](/gateway/security)。

## 協定類型與程式碼生成

- TypeBox 架構定義了協議。
- JSON Schema 是從這些架構生成的。
- Swift 模型是從 JSON Schema 生成的。

## 遠端存取

- 首選：Tailscale 或 VPN。
- 替代方案：SSH 隧道。

```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
```

- 相同的握手 + 認證 token 適用於隧道中。
- 在遠端設置中，可以為 WS 啟用 TLS + 可選的釘選。

## Operations snapshot

- 開始: `openclaw gateway` (前景，日誌輸出到 stdout)。
- 健康: `health` 通過 WS (也包含在 `hello-ok` 中)。
- 監控: 使用 launchd/systemd 進行自動重啟。

## 不變式

- 每個主機上僅有一個 Gateway 控制單一的 Baileys 會話。
- 握手是必須的；任何非 JSON 或非 connect 的第一幀將會強制關閉連接。
- 事件不會重播；用戶端必須在出現間隙時進行刷新。
