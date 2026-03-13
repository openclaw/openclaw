---
summary: "Gateway web surfaces: Control UI, bind modes, and security"
read_when:
  - You want to access the Gateway over Tailscale
  - You want the browser Control UI and config editing
title: Web
---

# Web（Gateway）

Gateway 從與 Gateway WebSocket 相同的埠口提供一個小型的 **瀏覽器控制介面**（Vite + Lit）：

- 預設：`http://<host>:18789/`
- 可選前綴：設定 `gateway.controlUi.basePath`（例如 `/openclaw`）

功能位於 [Control UI](/web/control-ui)。
本頁重點介紹綁定模式、安全性及面向網頁的介面。

## Webhooks

當 `hooks.enabled=true` 時，Gateway 也會在同一 HTTP 伺服器上開放一個小型的 webhook 端點。
請參考 [Gateway configuration](/gateway/configuration) → `hooks` 了解認證與負載格式。

## 設定（預設啟用）

當資源存在時（`dist/control-ui`），控制介面預設為 **啟用**。
你可以透過設定來控制它：

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## Tailscale 存取

### 整合 Serve（推薦）

將 Gateway 維持在 loopback，並讓 Tailscale Serve 代理它：

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

Open:

- `https://<magicdns>/`（或您設定的 `gateway.controlUi.basePath`）

### Tailnet 綁定 + token

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

接著啟動 gateway（非 loopback 綁定需要 token）：

```bash
openclaw gateway
```

Open:

- `http://<tailscale-ip>:18789/`（或您設定的 `gateway.controlUi.basePath`）

### 公網（Funnel）

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## 安全注意事項

- Gateway 預設需要驗證（token/密碼或 Tailscale 身份標頭）。
- 非 loopback 綁定仍然**需要**共用 token/密碼（`gateway.auth` 或環境變數）。
- 精靈預設會產生 gateway token（即使是 loopback）。
- UI 會傳送 `connect.params.auth.token` 或 `connect.params.auth.password`。
- 非 loopback Control UI 部署時，請明確設定 `gateway.controlUi.allowedOrigins`（完整來源）。若未設定，預設會拒絕 gateway 啟動。
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true` 啟用 Host-header 來源回退模式，但這是危險的安全降級。
- 使用 Serve 時，當 `gateway.auth.allowTailscale` 為 `true`（不需 token/密碼）時，Tailscale 身份標頭可用於 Control UI/WebSocket 驗證。HTTP API 端點仍需 token/密碼。設定 `gateway.auth.allowTailscale: false` 可強制要求明確憑證。詳見 [Tailscale](/gateway/tailscale) 與 [安全性](/gateway/security)。此無 token 流程假設 gateway 主機是受信任的。
- `gateway.tailscale.mode: "funnel"` 需要 `gateway.auth.mode: "password"`（共用密碼）。

## 建置 UI

Gateway 從 `dist/control-ui` 提供靜態檔案。使用以下指令建置：

```bash
pnpm ui:build # auto-installs UI deps on first run
```
