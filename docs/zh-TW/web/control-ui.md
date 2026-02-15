---
summary: "基於瀏覽器的 Gateway 控制介面（對話、節點、設定）"
read_when:
  - 您想從瀏覽器操作 Gateway
  - 您想要無需 SSH 通道的 Tailnet 存取權限
title: "控制介面"
---

# 控制介面 (瀏覽器)

控制介面是一個由 Gateway 提供的輕量級 **Vite + Lit** 單頁面應用程式 (SPA)：

- 預設：`http://<host>:18789/`
- 選用路徑前綴：設定 `gateway.controlUi.basePath`（例如 `/openclaw`）

它直接與相同連接埠上的 **Gateway WebSocket** 進行通訊。

## 快速開啟 (本地)

如果 Gateway 正在同一部電腦上執行，請開啟：

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/)（或 [http://localhost:18789/](http://localhost:18789/)）

如果頁面載入失敗，請先啟動 Gateway：`openclaw gateway`。

憑證是在 WebSocket 握手期間透過以下方式提供的：

- `connect.params.auth.token`
- `connect.params.auth.password`
  儀表板設定面板可讓您儲存 token；密碼不會被永久儲存。
  新手導覽精靈預設會產生一個 Gateway token，請在第一次連線時將其貼到此處。

## 裝置配對 (首次連線)

當您從新的瀏覽器或裝置連線到控制介面時，Gateway 需要一次性的 **配對核准** —— 即使您位於同一個 Tailnet 且 `gateway.auth.allowTailscale: true`。這是一項防止未授權存取的安全性措施。

**您會看到的訊息：** "disconnected (1008): pairing required"

**核准裝置：**

```bash
# 列出待處理請求
openclaw devices list

# 根據請求 ID 進行核准
openclaw devices approve <requestId>
```

核准後，系統會記住該裝置，除非您使用 `openclaw devices revoke --device <id> --role <role>` 撤銷，否則不需要重新核准。請參閱 [Devices CLI](/cli/devices) 了解 token 輪換與撤銷。

**注意事項：**

- 本地連線 (`127.0.0.1`) 會自動核准。
- 遠端連線 (區域網路、Tailnet 等) 需要明確核准。
- 每個瀏覽器設定檔都會產生唯一的裝置 ID，因此切換瀏覽器或清除瀏覽器資料將需要重新配對。

## 目前功能

- 透過 Gateway WS 與模型對話 (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- 在對話中串流傳輸工具呼叫與即時工具輸出卡片 (智慧代理事件)
- 頻道：WhatsApp/Telegram/Discord/Slack + 外掛頻道 (Mattermost 等) 狀態 + QR Code 登入 + 各頻道設定 (`channels.status`, `web.login.*`, `config.patch`)
- 執行個體：在線列表與重新整理 (`system-presence`)
- 工作階段：列表與個別工作階段的思考/詳細模式覆寫 (`sessions.list`, `sessions.patch`)
- Cron 排程任務：列表/新增/執行/啟用/停用 + 執行紀錄 (`cron.*`)
- Skills：狀態、啟用/停用、安裝、API 金鑰更新 (`skills.*`)
- 節點：列表與功能 (`node.list`)
- 執行核准：編輯 Gateway 或節點允許清單 + 針對 `exec host=gateway/node` 詢問原則 (`exec.approvals.*`)
- 設定：檢視/編輯 `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- 設定：套用 + 驗證後重新啟動 (`config.apply`) 並喚醒最後一個活動中的工作階段
- 設定寫入包含 base-hash 保護，以防止覆蓋並行編輯
- 設定結構 (Schema) 與表單呈現 (`config.schema`，包含外掛與頻道結構)；原始 JSON 編輯器仍可使用
- 除錯：狀態/健康檢查/模型快照 + 事件日誌 + 手動 RPC 呼叫 (`status`, `health`, `models.list`)
- 日誌：即時追蹤 Gateway 檔案日誌，具備過濾與匯出功能 (`logs.tail`)
- 更新：執行套件/git 更新 + 重新啟動 (`update.run`) 並提供重新啟動報告

Cron 排程任務面板說明：

- 對於獨立任務，傳送預設為公告摘要。如果您只想進行內部執行，可以切換為 none。
- 選擇公告時，會顯示頻道/目標欄位。

## 對話行為

- `chat.send` 是 **非阻塞的**：它會立即以 `{ runId, status: "started" }` 進行確認，並透過 `chat` 事件串流傳輸回應。
- 使用相同的 `idempotencyKey` 重新傳送，執行時會傳回 `{ status: "in_flight" }`，完成後傳回 `{ status: "ok" }`。
- `chat.inject` 會在工作階段紀錄中附加一條助理筆記，並廣播一個僅供 UI 更新的 `chat` 事件 (不啟動智慧代理執行，不進行頻道傳送)。
- 停止：
  - 點擊 **停止** (呼叫 `chat.abort`)
  - 輸入 `/stop` (或 `stop|esc|abort|wait|exit|interrupt`) 進行頻外中止
  - `chat.abort` 支援 `{ sessionKey }` (無 `runId`) 以中止該工作階段的所有活動執行

## Tailnet 存取 (推薦)

### 整合式 Tailscale Serve (首選)

將 Gateway 保持在 local loopback，並讓 Tailscale Serve 以 HTTPS 進行代理：

```bash
openclaw gateway --tailscale serve
```

開啟：

- `https://<magicdns>/` (或您設定的 `gateway.controlUi.basePath`)

預設情況下，當 `gateway.auth.allowTailscale` 為 `true` 時，Serve 請求可以透過 Tailscale 身分識別標頭 (`tailscale-user-login`) 進行驗證。OpenClaw 會透過 `tailscale whois` 解析 `x-forwarded-for` 位址並與標頭匹配來驗證身分，且僅在請求透過 Tailscale 的 `x-forwarded-*` 標頭到達 local loopback 時才接受。如果您希望即使是 Serve 流量也需要 token/密碼，請設定 `gateway.auth.allowTailscale: false` (或強制設定 `gateway.auth.mode: "password"`)。

### 繫結至 Tailnet + token

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

然後開啟：

- `http://<tailscale-ip>:18789/` (或您設定的 `gateway.controlUi.basePath`)

將 token 貼到 UI 設定中 (以 `connect.params.auth.token` 傳送)。

## 不安全的 HTTP

如果您透過純 HTTP (`http://<lan-ip>` 或 `http://<tailscale-ip>`) 開啟儀表板，瀏覽器將在 **非安全內容 (non-secure context)** 中執行並封鎖 WebCrypto。預設情況下，OpenClaw 會 **封鎖** 沒有裝置身分識別的控制介面連線。

**推薦的修復方法：** 使用 HTTPS (Tailscale Serve) 或在本地開啟 UI：

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (在 Gateway 主機上)

**降級範例 (僅透過 HTTP 使用 token)：**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

這會停用控制介面的裝置身分識別與配對 (即使在 HTTPS 上)。僅在您信任該網路時使用。

請參閱 [Tailscale](/gateway/tailscale) 以獲取 HTTPS 設定指南。

## 建置 UI

Gateway 提供 `dist/control-ui` 中的靜態檔案。使用以下指令建置：

```bash
pnpm ui:build # 首次執行時會自動安裝 UI 依賴項
```

選用的絕對基底路徑 (當您想要固定的資產 URL 時)：

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

用於本地開發 (獨立的開發伺服器)：

```bash
pnpm ui:dev # 首次執行時會自動安裝 UI 依賴項
```

然後將 UI 指向您的 Gateway WS URL (例如 `ws://127.0.0.1:18789`)。

## 除錯/測試：開發伺服器 + 遠端 Gateway

控制介面是靜態檔案；WebSocket 目標是可設定的，且可以與 HTTP 來源不同。當您想在本地使用 Vite 開發伺服器，但 Gateway 在其他地方執行時，這非常方便。

1. 啟動 UI 開發伺服器：`pnpm ui:dev`
2. 開啟如下 URL：

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

選用的一次性驗證 (如果需要)：

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

注意事項：

- `gatewayUrl` 在載入後會儲存在 localStorage 中，並從 URL 中移除。
- `token` 儲存在 localStorage 中；`password` 僅保留在記憶體中。
- 設定 `gatewayUrl` 時，UI 不會退回到設定或環境變數憑證。請明確提供 `token` (或 `password`)。缺少明確憑證將會導致錯誤。
- 當 Gateway 位於 TLS 後方 (Tailscale Serve、HTTPS 代理等) 時，請使用 `wss://`。
- `gatewayUrl` 僅在頂層視窗中接受 (非嵌入式)，以防止點擊劫持 (clickjacking)。
- 對於跨來源開發設定 (例如將 `pnpm ui:dev` 連向遠端 Gateway)，請將 UI 來源新增至 `gateway.controlUi.allowedOrigins`。

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
