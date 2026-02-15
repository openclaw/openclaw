---
summary: "Gateway 網頁介面：控制 UI、綁定模式與安全性"
read_when:
  - 您想透過 Tailscale 存取 Gateway
  - 您需要瀏覽器控制 UI 與設定編輯功能
title: "網頁"
---

# 網頁 (Gateway)

Gateway 在與 Gateway WebSocket 相同的連接埠上提供一個小型的 **瀏覽器控制 UI** (Vite + Lit)：

- 預設：`http://<host>:18789/`
- 選用前綴：設定 `gateway.controlUi.basePath` (例如 `/openclaw`)

功能詳見 [控制 UI](/web/control-ui)。
本頁面重點介紹綁定模式、安全性以及面向網頁的介面。

## Webhooks

當 `hooks.enabled=true` 時，Gateway 也會在同一個 HTTP 伺服器上公開一個小型 Webhook 端點。
請參閱 [Gateway 設定](/gateway/configuration) → `hooks` 以了解驗證與有效負載的詳情。

## 設定 (預設開啟)

當資產存在時 (`dist/control-ui`)，控制 UI **預設為啟用**。
您可以透過設定進行控制：

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath 為選填
  },
}
```

## Tailscale 存取

### 整合式 Serve (推薦)

將 Gateway 保持在 local loopback，並讓 Tailscale Serve 進行代理：

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

接著啟動 Gateway：

```bash
openclaw gateway
```

開啟：

- `https://<magicdns>/` (或您設定的 `gateway.controlUi.basePath`)

### Tailnet 綁定 + 權杖

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

接著啟動 Gateway (非 loopback 綁定需要權杖)：

```bash
openclaw gateway
```

開啟：

- `http://<tailscale-ip>:18789/` (或您設定的 `gateway.controlUi.basePath`)

### 公開網際網路 (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // 或 OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## 安全性注意事項

- 預設情況下需要 Gateway 驗證 (權杖/密碼或 Tailscale 身分識別標頭)。
- 非 loopback 綁定仍 **需要** 共用權杖/密碼 (`gateway.auth` 或環境變數)。
- 新手導覽精靈預設會產生 Gateway 權杖 (即使在 loopback 上)。
- UI 會傳送 `connect.params.auth.token` 或 `connect.params.auth.password`。
- 控制 UI 會傳送抗點擊劫持 (anti-clickjacking) 標頭，且除非設定了 `gateway.controlUi.allowedOrigins`，否則僅接受同源 (same-origin) 的瀏覽器 WebSocket 連線。
- 使用 Serve 時，若 `gateway.auth.allowTailscale` 為 `true`，Tailscale 身分識別標頭即可滿足驗證需求 (不需要權杖/密碼)。設定 `gateway.auth.allowTailscale: false` 則需要明確的憑證。請參閱 [Tailscale](/gateway/tailscale) 與 [安全性](/gateway/security)。
- `gateway.tailscale.mode: "funnel"` 需要 `gateway.auth.mode: "password"` (共用密碼)。

## 建置 UI

Gateway 提供來自 `dist/control-ui` 的靜態檔案。請使用以下指令建置：

```bash
pnpm ui:build # 首次執行時會自動安裝 UI 依賴項目
```
