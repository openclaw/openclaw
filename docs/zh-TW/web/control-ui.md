---
summary: "Gateway 閘道器 的瀏覽器型控制 UI（聊天、節點、設定）"
read_when:
  - 你想要從瀏覽器操作 Gateway 閘道器
  - 你想要在沒有 SSH 通道 的情況下存取 Tailnet
title: "控制 UI"
---

# 控制 UI（瀏覽器）

控制 UI 是由 Gateway 閘道器 提供的一個小型 **Vite + Lit** 單頁應用程式：

- 預設：`http://<host>:18789/`
- 選用前綴：設定 `gateway.controlUi.basePath`（例如：`/openclaw`）

它會在相同的連接埠上 **直接與 Gateway WebSocket** 通訊。

## 快速開啟（本機）

如果 Gateway 閘道器 正在同一台電腦上執行，請開啟：

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/)（或 [http://localhost:18789/](http://localhost:18789/)）

如果頁面無法載入，請先啟動 Gateway 閘道器：`openclaw gateway`。

身分驗證會在 WebSocket 握手期間提供，方式如下：

- `connect.params.auth.token`
- 8. `connect.params.auth.password`
     儀表板設定面板可讓你儲存權杖；密碼不會被持久化保存。
  9. 上線引導精靈預設會產生一個 gateway 權杖，因此首次連線時請在此貼上。

## 裝置配對（首次連線）

當你從新的瀏覽器或裝置連線到控制 UI 時，Gateway 閘道器
需要 **一次性的配對核准** —— 即使你在相同的 Tailnet
且使用 `gateway.auth.allowTailscale: true`。這是一項安全措施，用以防止
未經授權的存取。 10. 這是一項安全措施，用以防止未經授權的存取。

**你會看到的訊息：**「disconnected (1008): pairing required」

**核准裝置的方法：**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

一旦核准，該裝置會被記住，除非你使用 `openclaw devices revoke --device <id> --role <role>` 將其撤銷，否則不需要重新核准。關於權杖輪替與撤銷，請參閱
[Devices CLI](/cli/devices)。 11. 請參閱
[Devices CLI](/cli/devices) 以了解權杖輪替與撤銷。

**注意事項：**

- Local connections (`127.0.0.1`) are auto-approved.
- 13. 遠端連線（LAN、Tailnet 等） 14. 需要明確核准。
- 15. 每個瀏覽器設定檔都會產生唯一的裝置 ID，因此切換瀏覽器或清除瀏覽器資料將需要重新配對。

## What it can do (today)

- 透過 Gateway WS 與模型聊天（`chat.history`、`chat.send`、`chat.abort`、`chat.inject`）
- 串流工具呼叫與即時工具輸出卡片（聊天中的代理程式事件）
- 17. 頻道：WhatsApp／Telegram／Discord／Slack + 外掛頻道（Mattermost 等） 頻道：WhatsApp/Telegram/Discord/Slack + 外掛頻道（Mattermost 等）的狀態 + QR 登入 + 各頻道設定（`channels.status`、`web.login.*`、`config.patch`）
- Instances：線上清單 + 重新整理（`system-presence`）
- Sessions：清單 + 各工作階段的 thinking/verbose 覆寫（`sessions.list`、`sessions.patch`）
- Cron jobs：列出/新增/執行/啟用/停用 + 執行歷史（`cron.*`）
- Skills：狀態、啟用/停用、安裝、API 金鑰更新（`skills.*`）
- Nodes：清單 + 能力（caps）（`node.list`）
- Exec 核准：編輯 Gateway 或節點的允許清單 + 針對 `exec host=gateway/node` 的詢問政策（`exec.approvals.*`）
- 設定：檢視/編輯 `~/.openclaw/openclaw.json`（`config.get`、`config.set`）
- 設定：套用 + 重新啟動並進行驗證（`config.apply`），並喚醒最後一個作用中的工作階段
- 設定寫入包含基礎雜湊防護，以避免覆寫同時進行的編輯
- 設定結構描述 + 表單轉譯（`config.schema`，包含外掛與頻道結構描述）；Raw JSON 編輯器仍可使用
- 偵錯：狀態/健康/模型快照 + 事件記錄 + 手動 RPC 呼叫（`status`、`health`、`models.list`）
- Logs: live tail of gateway file logs with filter/export (`logs.tail`)
- 更新：執行套件/git 更新 + 重新啟動（`update.run`），並提供重新啟動報告

Cron jobs 面板注意事項：

- 19. 對於隔離的工作，傳遞方式預設為公告摘要。 20. 若只想進行內部執行，你可以切換為 none。
- Channel/target fields appear when announce is selected.

## 聊天行為

- `chat.send` 為 **非阻塞**：會立即以 `{ runId, status: "started" }` 回應確認，並透過 `chat` 事件串流回傳回應。
- 使用相同的 `idempotencyKey` 重新送出時，執行中會回傳 `{ status: "in_flight" }`，完成後回傳 `{ status: "ok" }`。
- `chat.inject` 會在工作階段逐字稿中附加一則助理備註，並廣播 `chat` 事件以進行僅限 UI 的更新（不執行代理程式、不投遞到頻道）。
- 停止：
  - 點擊 **Stop**（呼叫 `chat.abort`）
  - 輸入 `/stop`（或 `stop|esc|abort|wait|exit|interrupt`）以帶外中止
  - `chat.abort` 支援 `{ sessionKey }`（無 `runId`），以中止該工作階段中的所有作用中執行

## Tailnet 存取（建議）

### 整合式 Tailscale Serve（首選）

將 Gateway 閘道器 維持在 loopback，並讓 Tailscale Serve 以 HTTPS 進行代理：

```bash
openclaw gateway --tailscale serve
```

開啟：

- `https://<magicdns>/`（或你設定的 `gateway.controlUi.basePath`）

By default, Serve requests can authenticate via Tailscale identity headers
(`tailscale-user-login`) when `gateway.auth.allowTailscale` is `true`. OpenClaw
verifies the identity by resolving the `x-forwarded-for` address with
`tailscale whois` and matching it to the header, and only accepts these when the
request hits loopback with Tailscale’s `x-forwarded-*` headers. 24. 若即使是 Serve 流量也想要求權杖／密碼，請設定
`gateway.auth.allowTailscale: false`（或強制 `gateway.auth.mode: "password"`）。

### 綁定至 tailnet + 權杖

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

接著開啟：

- `http://<tailscale-ip>:18789/`（或你設定的 `gateway.controlUi.basePath`）

將權杖貼到 UI 設定中（以 `connect.params.auth.token` 傳送）。

## 不安全的 HTTP

25. 若你透過純 HTTP（`http://<lan-ip>` 或 `http://<tailscale-ip>`）開啟儀表板，瀏覽器會在**非安全內容**中執行並封鎖 WebCrypto。 By default,
    OpenClaw **blocks** Control UI connections without device identity.

**建議的修正方式：** 使用 HTTPS（Tailscale Serve）或在本機開啟 UI：

- `https://<magicdns>/`（Serve）
- `http://127.0.0.1:18789/`（在 閘道器主機 上）

**降級範例（僅權杖、透過 HTTP）：**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

這會停用控制 UI 的裝置身分與配對（即使在 HTTPS 上）。僅在你信任網路時使用。 Use
only if you trust the network.

關於 HTTPS 設定指引，請參閱 [Tailscale](/gateway/tailscale)。

## 建置 UI

Gateway 閘道器 會從 `dist/control-ui` 提供靜態檔案。請使用以下方式建置： Build them with:

```bash
pnpm ui:build # auto-installs UI deps on first run
```

選用的絕對 base（當你需要固定的資產 URL 時）：

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

本機開發（獨立的開發伺服器）：

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

接著將 UI 指向你的 Gateway WS URL（例如：`ws://127.0.0.1:18789`）。

## 偵錯/測試：開發伺服器 + 遠端 Gateway

The Control UI is static files; the WebSocket target is configurable and can be
different from the HTTP origin. This is handy when you want the Vite dev server
locally but the Gateway runs elsewhere.

1. 啟動 UI 開發伺服器：`pnpm ui:dev`
2. 開啟如下的 URL：

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

選用的一次性身分驗證（若需要）：

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

注意事項：

- `gatewayUrl` 會在載入後儲存在 localStorage，並從 URL 中移除。
- `token` 會儲存在 localStorage；`password` 僅保留在記憶體中。
- 當設定 `gatewayUrl` 時，UI 不會回退使用設定或環境中的憑證。
  請明確提供 `token`（或 `password`）。缺少明確憑證將視為錯誤。
  Provide `token` (or `password`) explicitly. 32. 缺少明確的認證資訊會被視為錯誤。
- 當 Gateway 位於 TLS 後方（Tailscale Serve、HTTPS 代理等）時，請使用 `wss://`。
- 為避免點擊劫持，`gatewayUrl` 僅在最上層視窗中接受（不可內嵌）。
- 對於跨來源的開發設定（例如：`pnpm ui:dev` 連線到遠端 Gateway），請將 UI
  來源加入 `gateway.controlUi.allowedOrigins`。

範例：

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

遠端存取設定細節：[Remote access](/gateway/remote)。
