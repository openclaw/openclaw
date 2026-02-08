---
summary: "Gateway 網頁介面：控制 UI、綁定模式與安全性"
read_when:
  - 你想要透過 Tailscale 存取 Gateway
  - 你想要瀏覽器控制 UI 與設定編輯
title: "Web"
x-i18n:
  source_path: web/index.md
  source_hash: 1315450b71a799c8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:29:40Z
---

# Web（Gateway）

Gateway 會從與 Gateway WebSocket 相同的連接埠提供一個小型的 **瀏覽器控制 UI**（Vite + Lit）：

- 預設：`http://<host>:18789/`
- 選用前綴：設定 `gateway.controlUi.basePath`（例如 `/openclaw`）

功能位於 [Control UI](/web/control-ui)。
本頁聚焦於綁定模式、安全性，以及對外的網頁介面。

## Webhooks

當 `hooks.enabled=true` 時，Gateway 也會在相同的 HTTP 伺服器上公開一個小型 webhook 端點。
請參閱 [Gateway 設定](/gateway/configuration) → `hooks` 以了解身分驗證與承載內容。

## 設定（預設開啟）

當資產存在時（`dist/control-ui`），控制 UI **預設為啟用**。
你可以透過設定來控制它：

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## Tailscale 存取

### 整合 Serve（建議）

讓 Gateway 維持在 local loopback，並由 Tailscale Serve 進行代理：

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

接著啟動 gateway：

```bash
openclaw gateway
```

開啟：

- `https://<magicdns>/`（或你設定的 `gateway.controlUi.basePath`）

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

接著啟動 gateway（非 loopback 綁定需要權杖）：

```bash
openclaw gateway
```

開啟：

- `http://<tailscale-ip>:18789/`（或你設定的 `gateway.controlUi.basePath`）

### 公開網際網路（Funnel）

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## 安全性注意事項

- Gateway 身分驗證預設為必須（權杖／密碼或 Tailscale 身分標頭）。
- 非 loopback 綁定仍然**需要**共享的權杖／密碼（`gateway.auth` 或 環境變數）。
- 精靈預設會產生 gateway 權杖（即使在 loopback 上）。
- UI 會傳送 `connect.params.auth.token` 或 `connect.params.auth.password`。
- 控制 UI 會傳送防點擊劫持標頭，且除非設定 `gateway.controlUi.allowedOrigins`，否則只接受同源瀏覽器
  WebSocket 連線。
- 使用 Serve 時，當 `gateway.auth.allowTailscale` 為 `true` 時，Tailscale 身分標頭可滿足身分驗證
  （不需要權杖／密碼）。設定 `gateway.auth.allowTailscale: false` 以要求明確的憑證。請參閱
  [Tailscale](/gateway/tailscale) 與 [Security](/gateway/security)。
- `gateway.tailscale.mode: "funnel"` 需要 `gateway.auth.mode: "password"`（共享密碼）。

## 建置 UI

Gateway 會從 `dist/control-ui` 提供靜態檔案。使用以下方式建置：

```bash
pnpm ui:build # auto-installs UI deps on first run
```
