---
summary: "Gateway 網頁介面：控制 UI、綁定模式和安全性"
read_when:
  - 您希望透過 Tailscale 存取 Gateway
  - 您希望使用瀏覽器控制 UI 並編輯設定
title: "網頁"
---

# 網頁 (Gateway)

Gateway 從與 Gateway WebSocket 相同的埠提供一個小型的 **瀏覽器控制 UI** (Vite + Lit)：

- 預設值: `http://<host>:18789/`
- 可選前綴：設定 `gateway.controlUi.basePath` (例如 `/openclaw`)

功能位於 [控制 UI](/web/control-ui)。
此頁面專注於綁定模式、安全性以及網頁介面。

## Webhooks

當 `hooks.enabled=true` 時，Gateway 也會在相同的 HTTP 伺服器上公開一個小型 Webhook 端點。
請參閱 [Gateway 設定](/gateway/configuration) → `hooks` 以了解憑證 + 有效負載。

## 設定 (預設啟用)

當資源存在 (`dist/control-ui`) 時，控制 UI 會**預設啟用**。
您可以透過設定來控制它：

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## Tailscale 存取

### 整合式 Serve (建議)

讓 Gateway 保持在 local loopback 上，並讓 Tailscale Serve 代理它：

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

然後啟動 Gateway：

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

然後啟動 Gateway (非 local loopback 綁定需要權杖)：

```bash
openclaw gateway
```

開啟：

- `http://<tailscale-ip>:18789/` (或您設定的 `gateway.controlUi.basePath`)

### 公共網路 (Funnel)

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

- Gateway 預設需要憑證 (權杖/密碼或 Tailscale 身份標頭)。
- 非 local loopback 綁定仍然**需要**共用權杖/密碼 (`gateway.auth` 或 環境變數)。
- 精靈預設會產生一個 Gateway 權杖 (即使在 local loopback 上)。
- UI 傳送 `connect.params.auth.token` 或 `connect.params.auth.password`。
- 控制 UI 傳送反點擊劫持標頭，並且只接受同源瀏覽器 WebSocket 連線，除非設定了 `gateway.controlUi.allowedOrigins`。
- 使用 Serve，當 `gateway.auth.allowTailscale` 為 `true` 時，Tailscale 身份標頭可以滿足憑證要求 (無需權杖/密碼)。將 `gateway.auth.allowTailscale: false` 設定為需要明確的憑證。請參閱 [Tailscale](/gateway/tailscale) 和 [安全性](/gateway/security)。
- `gateway.tailscale.mode: "funnel"` 需要 `gateway.auth.mode: "password"` (共用密碼)。

## 建構 UI

Gateway 從 `dist/control-ui` 提供靜態檔案。使用以下方式建構它們：

```bash
pnpm ui:build # auto-installs UI deps on first run
```
