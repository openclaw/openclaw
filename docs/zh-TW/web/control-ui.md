---
summary: "Browser-based control UI for the Gateway (chat, nodes, config)"
read_when:
  - You want to operate the Gateway from a browser
  - You want Tailnet access without SSH tunnels
title: Control UI
---

# 控制介面 (瀏覽器)

控制介面是一個由 Gateway 提供服務的小型 **Vite + Lit** 單頁應用程式：

- 預設：`http://<host>:18789/`
- 可選前綴：設定 `gateway.controlUi.basePath`（例如 `/openclaw`）

它直接與同一埠口的 Gateway WebSocket 通訊。

## 快速開啟（本機）

如果 Gateway 執行在同一台電腦，請開啟：

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/)（或 [http://localhost:18789/](http://localhost:18789/)）

如果頁面無法載入，請先啟動 Gateway：`openclaw gateway`。

認證會在 WebSocket 握手時提供：

- `connect.params.auth.token`
- `connect.params.auth.password`
  儀表板設定面板會為目前瀏覽器分頁會話及所選的 gateway URL 保留 token；密碼不會被保存。
  新手導引預設會產生一個 gateway token，因此首次連線時請將它貼上。

## 裝置配對（首次連線）

當你從新的瀏覽器或裝置連接控制介面時，Gateway
需要進行 **一次性配對批准** — 即使你在同一個 Tailnet
中 `gateway.auth.allowTailscale: true`。這是為了防止未授權存取的安全措施。

**你會看到的訊息：**「disconnected (1008)：需要配對」

**批准裝置的方法：**

bash

# 列出待處理請求

openclaw devices list

# 透過請求 ID 批准

openclaw devices approve <requestId>

一旦批准，該裝置將被記住，除非你使用 `openclaw devices revoke --device <id> --role <role>` 撤銷，否則不需要重新批准。詳見
[Devices CLI](/cli/devices) 了解 token 旋轉與撤銷。

**注意事項：**

- 本地連線 (`127.0.0.1`) 會自動批准。
- 遠端連線（LAN、Tailnet 等）需要明確批准。
- 每個瀏覽器設定檔會產生獨立的裝置 ID，切換瀏覽器或清除瀏覽器資料會需要重新配對。

## 語言支援

控制介面在首次載入時會根據瀏覽器語系自動本地化，之後可在 Access 卡片的語言選擇器中手動切換。

- 支援語系：`en`, `zh-CN`, `zh-TW`, `pt-BR`, `de`, `es`
- 非英文翻譯會在瀏覽器中延遲載入。
- 選擇的語系會儲存在瀏覽器儲存空間，未來造訪時會重複使用。
- 缺少的翻譯鍵會回退顯示英文。

## 目前功能

- 透過 Gateway WS 與模型聊天 (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- 聊天中串流工具呼叫與即時工具輸出卡片（代理事件）
- 頻道：WhatsApp/Telegram/Discord/Slack + 外掛頻道（Mattermost 等）狀態 + QR 登入 + 每頻道設定 (`channels.status`, `web.login.*`, `config.patch`)
- 實例：在線列表 + 重新整理 (`system-presence`)
- 工作階段：列表 + 每會話思考/快速/詳細/推理覆寫 (`sessions.list`, `sessions.patch`)
- 排程工作：列表/新增/編輯/執行/啟用/停用 + 執行歷史 (`cron.*`)
- 技能：狀態、啟用/停用、安裝、API 金鑰更新 (`skills.*`)
- 節點：列表 + 權限 (`node.list`)
- 執行批准：編輯 gateway 或節點允許清單 + 詢問政策 `exec host=gateway/node` (`exec.approvals.*`)
- 設定：檢視/編輯 `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- 設定：套用 + 驗證後重啟 (`config.apply`) 並喚醒最後活躍會話
- 設定寫入包含基底雜湊保護，防止同時編輯覆蓋
- 設定結構與表單渲染 (`config.schema`，包含外掛與頻道結構)；仍保留原始 JSON 編輯器
- 除錯：狀態/健康/模型快照 + 事件日誌 + 手動 RPC 呼叫 (`status`, `health`, `models.list`)
- 日誌：Gateway 檔案日誌即時尾端，含篩選/匯出 (`logs.tail`)
- 更新：執行套件/版本更新 + 重啟 (`update.run`) 並提供重啟報告

排程工作面板說明：

- 對於獨立工作，預設交付為公告摘要。若只想內部執行可切換為無交付。
- 選擇公告時會顯示頻道/目標欄位。
- Webhook 模式使用 `delivery.mode = "webhook"`，並將 `delivery.to` 設為有效的 HTTP(S) webhook URL。
- 主要會話工作可使用 webhook 與無交付模式。
- 進階編輯控制包含執行後刪除、清除代理覆寫、cron 精確/錯開選項、代理模型/思考覆寫，以及盡力交付切換。
- 表單驗證為內嵌欄位錯誤；無效值會禁用儲存按鈕直到修正。
- 設定 `cron.webhookToken` 可傳送專用 bearer token，若省略 webhook 則不帶授權標頭。
- 已棄用的回退：存有 `notify: true` 的舊版工作仍可使用 `cron.webhook`，直到完成遷移。

## 聊天行為

- `chat.send` 是**非阻塞**的：會立即以 `{ runId, status: "started" }` 確認，回應透過 `chat` 事件串流。
- 使用相同 `idempotencyKey` 重送時，執行中回傳 `{ status: "in_flight" }`，完成後回傳 `{ status: "ok" }`。
- `chat.history` 回應有大小限制以確保 UI 安全。當文字過長，Gateway 可能截斷長文字欄位、省略大量元資料區塊，並以佔位符 (`[chat.history omitted: message too large]`) 取代過大訊息。
- `chat.inject` 會在會話記錄附加助理備註，並廣播 `chat` 事件供 UI 更新（無代理執行，無頻道傳送）。
- 停止：
  - 點擊 **停止**（呼叫 `chat.abort`）
  - 輸入 `/stop`（或獨立中止語句如 `stop`, `stop action`, `stop run`, `stop openclaw`, `please stop`）以非同步中止
  - `chat.abort` 支援 `{ sessionKey }`（無 `runId`）以中止該會話所有執行中任務
- 中止部分保留：
  - 執行中止時，部分助理文字仍可在 UI 顯示
  - Gateway 會將中止的部分助理文字持久化到記錄歷史，當有緩衝輸出時
  - 持久化條目包含中止元資料，讓記錄消費者能區分中止部分與正常完成輸出

## Tailnet 存取（推薦）

### 整合 Tailscale Serve（首選）

將 Gateway 維持在迴路介面，並讓 Tailscale Serve 以 HTTPS 代理它：

```bash
openclaw gateway --tailscale serve
```

開啟：

- `https://<magicdns>/`（或您設定的 `gateway.controlUi.basePath`）

預設情況下，Control UI/WebSocket Serve 請求可以透過 Tailscale 身分標頭
(`tailscale-user-login`) 進行驗證，當 `gateway.auth.allowTailscale` 為 `true` 時。OpenClaw
會透過解析 `x-forwarded-for` 位址與
`tailscale whois` 進行比對，並核對標頭，且僅在請求透過迴路介面且帶有 Tailscale 的 `x-forwarded-*` 標頭時接受這些請求。若您想要求 Serve 流量也必須使用 token/密碼，請設定
`gateway.auth.allowTailscale: false`（或強制 `gateway.auth.mode: "password"`）。
無 token 的 Serve 驗證假設閘道主機是受信任的。如果該主機可能執行不受信任的本地程式碼，請要求 token/密碼驗證。

### 綁定到 tailnet + token

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

接著開啟：

- `http://<tailscale-ip>:18789/`（或您設定的 `gateway.controlUi.basePath`）

將 token 貼到 UI 設定中（會以 `connect.params.auth.token` 方式傳送）。

## 不安全的 HTTP

如果您透過純 HTTP（`http://<lan-ip>` 或 `http://<tailscale-ip>`）開啟儀表板，
瀏覽器會在**非安全環境**下執行並阻擋 WebCrypto。預設情況下，
OpenClaw **會阻擋** 沒有裝置身分的 Control UI 連線。

**建議解決方案：** 使用 HTTPS（Tailscale Serve）或在本機開啟 UI：

- `https://<magicdns>/`（Serve）
- `http://127.0.0.1:18789/`（在閘道主機上）

**不安全驗證切換行為：**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

`allowInsecureAuth` 僅為本地相容性切換：

- 它允許 localhost 的 Control UI 會話在非安全的 HTTP 環境中，無需裝置身份即可繼續。
- 它不會繞過配對檢查。
- 它不會放寬遠端（非 localhost）裝置身份的要求。

**僅限緊急解鎖使用：**

```json5
{
  gateway: {
    controlUi: { dangerouslyDisableDeviceAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

`dangerouslyDisableDeviceAuth` 會停用 Control UI 的裝置身份檢查，這是嚴重的安全降級。緊急使用後請盡快還原。

請參考 [Tailscale](/gateway/tailscale) 以取得 HTTPS 設定指引。

## 建置 UI

Gateway 從 `dist/control-ui` 提供靜態檔案。使用以下指令建置：

```bash
pnpm ui:build # auto-installs UI deps on first run
```

可選的絕對基底路徑（當你需要固定資源 URL 時）：

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

本地開發（使用獨立開發伺服器）：

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

接著將 UI 指向你的 Gateway WS URL（例如 `ws://127.0.0.1:18789`）。

## 除錯/測試：開發伺服器 + 遠端 Gateway

Control UI 是靜態檔案；WebSocket 目標可設定，且可以與 HTTP 來源不同。當你想在本地使用 Vite 開發伺服器，但 Gateway 執行在其他地方時，這非常方便。

1. 啟動 UI 開發伺服器：`pnpm ui:dev`
2. 開啟類似以下的 URL：

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

可選的一次性認證（如有需要）：

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789#token=<gateway-token>
```

注意事項：

- `gatewayUrl` 會在載入後存到 localStorage，並從 URL 中移除。
- `token` 從 URL 片段匯入，存到 sessionStorage，針對目前瀏覽器分頁會話和所選的 gateway URL，並從 URL 中剝除；不會存到 localStorage。
- `password` 僅保留在記憶體中。
- 當設定了 `gatewayUrl`，UI 不會回退使用設定或環境憑證。必須明確提供 `token`（或 `password`）。缺少明確憑證會導致錯誤。
- Gateway 在 TLS 後方（如 Tailscale Serve、HTTPS 代理等）時，請使用 `wss://`。
- `gatewayUrl` 僅接受於頂層視窗（非嵌入式），以防止點擊劫持。
- 非迴圈回送（non-loopback）的 Control UI 部署必須明確設定 `gateway.controlUi.allowedOrigins`（完整來源），包含遠端開發環境。
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true` 啟用 Host-header origin 回退模式，但這是危險的安全模式。

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

遠端存取設定詳情：[遠端存取](/gateway/remote)。
