---
summary: "Gateway 的瀏覽器控制使用者介面 (對談、節點、設定)"
read_when:
  - 您想從瀏覽器操作 Gateway
  - 您想要在沒有 SSH 通道的情況下存取 Tailnet
title: "控制使用者介面"
---

# 控制使用者介面 (瀏覽器)

控制使用者介面是一個小型的 **Vite + Lit** 單頁應用程式，由 Gateway 提供：

- 預設: `http://<host>:18789/`
- 可選前綴: 設定 `gateway.controlUi.basePath` (例如 `/openclaw`)

它直接與同一個連接埠上的 **Gateway WebSocket** 進行通訊。

## 快速開啟 (本機)

如果 Gateway 正在同一台電腦上執行，請開啟：

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (或 [http://localhost:18789/](http://localhost:18789/))

如果頁面載入失敗，請先啟動 Gateway：`openclaw gateway`。

憑證在 WebSocket 握手期間透過以下方式提供：

- `connect.params.auth.token`
- `connect.params.auth.password`
儀表板設定面板允許您儲存 token；密碼不會持久保存。
新手導覽精靈預設會生成一個 gateway token，因此首次連線時請將其貼在此處。

## 裝置配對 (首次連線)

當您從新瀏覽器或裝置連線到控制使用者介面時，Gateway
需要**一次性配對核准**——即使您在具有 `gateway.auth.allowTailscale: true` 的同一 Tailnet 上。這是一種安全措施，可防止
未經授權的存取。

**您將會看到：** "disconnected (1008): pairing required"

**核准裝置：**

```bash
# 列出待處理的請求
openclaw devices list

# 根據請求 ID 核准
openclaw devices approve <requestId>
```

一旦核准，裝置將被記住，除非您使用 `openclaw devices revoke --device <id> --role <role>` 撤銷它，否則無需重新核准。請參閱
[Devices CLI](/cli/devices) 以了解 token 輪換和撤銷。

**注意事項：**

- 本機連線 (`127.0.0.1`) 會自動核准。
- 遠端連線 (LAN、Tailnet 等) 需要明確核准。
- 每個瀏覽器設定檔都會生成一個唯一的裝置 ID，因此切換瀏覽器或
  清除瀏覽器資料將需要重新配對。

## 功能 (現階段)

- 透過 Gateway WS 與模型對談 (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- 在對談中串流工具呼叫 + 即時工具輸出卡片 (智慧代理事件)
- 頻道: WhatsApp/Telegram/Discord/Slack + 外掛程式頻道 (Mattermost 等) 狀態 + QR 登入 + 每個頻道的設定 (`channels.status`, `web.login.*`, `config.patch`)
- 實例: 狀態列表 + 重新整理 (`system-presence`)
- 工作階段: 列表 + 每個工作階段的思考/詳細覆蓋 (`sessions.list`, `sessions.patch`)
- 排程工作: 列表/新增/執行/啟用/停用 + 執行歷史 (`cron.*`)
- Skills: 狀態、啟用/停用、安裝、API 鍵更新 (`skills.*`)
- 節點: 列表 + 限制 (`node.list`)
- 執行核准: 編輯 gateway 或節點允許清單 + 針對 `exec host=gateway/node` 的政策要求 (`exec.approvals.*`)
- 設定: 檢視/編輯 `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- 設定: 應用 + 重新啟動並驗證 (`config.apply`) 並喚醒上次活動的工作階段
- 設定寫入包含一個基本雜湊防護，以防止覆蓋並發編輯
- 設定綱要 + 表單渲染 (`config.schema`，包括外掛程式 + 頻道綱要)；原始 JSON 編輯器仍然可用
- 除錯: 狀態/健康/模型快照 + 事件日誌 + 手動 RPC 呼叫 (`status`, `health`, `models.list`)
- 日誌: 帶有篩選/匯出的 gateway 檔案日誌即時追蹤 (`logs.tail`)
- 更新: 執行套件/git 更新 + 重新啟動 (`update.run`) 並附帶重新啟動報告

排程工作面板注意事項：

- 對於隔離的工作，傳遞預設為宣布摘要。如果您想要內部專用執行，可以切換到無。
- 當選擇宣布時，頻道/目標欄位會出現。

## 對談行為

- `chat.send` 是**非阻塞**的：它會立即回傳 `{ runId, status: "started" }`，並透過 `chat` 事件串流回應。
- 使用相同的 `idempotencyKey` 重新傳送，執行中會回傳 `{ status: "in_flight" }`，完成後會回傳 `{ status: "ok" }`。
- `chat.inject` 會將智慧代理的註釋附加到工作階段記錄中，並廣播一個 `chat` 事件以進行僅限使用者介面的更新 (沒有智慧代理執行，也沒有頻道傳遞)。
- 停止：
  - 點擊**停止** (呼叫 `chat.abort`)
  - 輸入 `/stop` (或 `stop|esc|abort|wait|exit|interrupt`) 以進行帶外中止
  - `chat.abort` 支援 `{ sessionKey }` (無 `runId`) 以中止該工作階段的所有活動執行

## Tailnet 存取 (建議)

### 整合式 Tailscale Serve (首選)

將 Gateway 保持在 local loopback 上，並讓 Tailscale Serve 透過 HTTPS 代理它：

```bash
openclaw gateway --tailscale serve
```

開啟：

- `https://<magicdns>/` (或您配置的 `gateway.controlUi.basePath`)

預設情況下，當 `gateway.auth.allowTailscale` 為 `true` 時，Serve 請求可以透過 Tailscale 身分標頭 (`tailscale-user-login`) 進行驗證。OpenClaw
透過使用 `tailscale whois` 解析 `x-forwarded-for` 地址並將其與標頭匹配來驗證身分，並且只有當請求到達帶有 Tailscale 的 `x-forwarded-*` 標頭的 local loopback 時才接受這些請求。
如果您希望即使對於 Serve 流量也需要 token/密碼，請設定 `gateway.auth.allowTailscale: false` (或強制 `gateway.auth.mode: "password"`)。

### 綁定到 tailnet + token

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

然後開啟：

- `http://<tailscale-ip>:18789/` (或您配置的 `gateway.controlUi.basePath`)

將 token 貼到使用者介面設定中 (作為 `connect.params.auth.token` 傳送)。

## 不安全的 HTTP

如果您透過純 HTTP (`http://<lan-ip>` 或 `http://<tailscale-ip>`) 開啟儀表板，
瀏覽器會在**非安全內容**中執行，並阻擋 WebCrypto。預設情況下，
OpenClaw **阻擋**沒有裝置身分的控制使用者介面連線。

**建議的修正：** 使用 HTTPS (Tailscale Serve) 或在本機開啟使用者介面：

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (在 gateway host 上)

**降級範例 (僅限 HTTP 上的 token)：**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

這會停用控制使用者介面 (即使在 HTTPS 上) 的裝置身分 + 配對。
僅在您信任網路的情況下使用。

請參閱 [Tailscale](/gateway/tailscale) 以取得 HTTPS 設定指南。

## 建構使用者介面

Gateway 從 `dist/control-ui` 提供靜態檔案。使用以下命令建構它們：

```bash
pnpm ui:build # 首次執行時自動安裝 UI 相依性
```

可選的絕對基礎路徑 (當您想要固定資產 URL 時)：

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

用於本機開發 (獨立的開發伺服器)：

```bash
pnpm ui:dev # 首次執行時自動安裝 UI 相依性
```

然後將使用者介面指向您的 Gateway WS URL (例如 `ws://127.0.0.1:18789`)。

## 除錯/測試：開發伺服器 + 遠端 Gateway

控制使用者介面是靜態檔案；WebSocket 目標是可配置的，並且可以與
HTTP 來源不同。當您想要在本機使用 Vite 開發伺服器，但 Gateway 執行在
其他地方時，這會很方便。

1. 啟動使用者介面開發伺服器：`pnpm ui:dev`
2. 開啟一個類似以下的 URL：

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

可選的一次性憑證 (如果需要)：

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

注意事項：

- `gatewayUrl` 在載入後儲存在 localStorage 中，並從 URL 中移除。
- `token` 儲存在 localStorage 中；`password` 僅保存在記憶體中。
- 當設定 `gatewayUrl` 時，使用者介面不會回溯到設定或環境憑證。
  明確提供 `token` (或 `password`)。缺少明確的憑證是一個錯誤。
- 當 Gateway 位於 TLS 後方時 (Tailscale Serve、HTTPS 代理等)，使用 `wss://`。
- `gatewayUrl` 僅在頂級視窗中接受 (不嵌入)，以防止點擊劫持。
- 對於跨來源開發設定 (例如將 `pnpm ui:dev` 指向遠端 Gateway)，請將使用者介面
  來源新增到 `gateway.controlUi.allowedOrigins`。

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

遠端存取設定詳情：[Remote access](/gateway/remote)。
