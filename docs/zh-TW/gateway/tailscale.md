---
summary: Integrated Tailscale Serve/Funnel for the Gateway dashboard
read_when:
  - Exposing the Gateway Control UI outside localhost
  - Automating tailnet or public dashboard access
title: Tailscale
---

# Tailscale (閘道儀表板)

OpenClaw 可以自動設定 Tailscale **Serve** (tailnet) 或 **Funnel** (public) 以用於 Gateway 儀表板和 WebSocket 端口。這樣可以保持 Gateway 綁定於回環地址，同時 Tailscale 提供 HTTPS、路由，以及 (對於 Serve) 身份標頭。

## Modes

- `serve`: 僅限 Tailnet 的服務透過 `tailscale serve`。閘道保持在 `127.0.0.1`。
- `funnel`: 公共 HTTPS 透過 `tailscale funnel`。OpenClaw 需要共享密碼。
- `off`: 預設（無 Tailscale 自動化）。

## Auth

將 `gateway.auth.mode` 設定為控制握手：

- `token` （當 `OPENCLAW_GATEWAY_TOKEN` 設定時的預設值）
- `password` （透過 `OPENCLAW_GATEWAY_PASSWORD` 或設定的共享密鑰）

當 `tailscale.mode = "serve"` 和 `gateway.auth.allowTailscale` 為 `true` 時，控制 UI/WebSocket 認證可以使用 Tailscale 身份標頭 (`tailscale-user-login`)，而無需提供 token/密碼。OpenClaw 通過本地 Tailscale 守護進程 (`tailscale whois`) 解析 `x-forwarded-for` 地址並將其與標頭匹配，以驗證身份，然後才接受請求。OpenClaw 只有在請求來自回環地址並且包含 Tailscale 的 `x-forwarded-for`、`x-forwarded-proto` 和 `x-forwarded-host` 標頭時，才會將其視為服務請求。HTTP API 端點（例如 `/v1/*`、`/tools/invoke` 和 `/api/channels/*`）仍然需要 token/密碼認證。這種無 token 流程假設網關主機是可信的。如果不可信的本地程式碼可能在同一主機上執行，請禁用 `gateway.auth.allowTailscale` 並改為要求 token/密碼認證。要要求明確的憑證，請設置 `gateway.auth.allowTailscale: false` 或強制 `gateway.auth.mode: "password"`。

## Config 範例

### Tailnet-only (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Open: `https://<magicdns>/` (或您設定的 `gateway.controlUi.basePath`)

### 僅限 Tailnet（綁定到 Tailnet IP）

當您希望 Gateway 直接在 Tailnet IP 上監聽時（不使用 Serve/Funnel），請使用此選項。

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

從另一個 Tailnet 裝置連接：

- 控制 UI: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

注意：在此模式下，loopback (`http://127.0.0.1:18789`) 將**無法**運作。

### 公共網路 (漏斗 + 共享密碼)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

偏好使用 `OPENCLAW_GATEWAY_PASSWORD` 而不是將密碼寫入磁碟。

## CLI 範例

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## Notes

- Tailscale Serve/Funnel 需要安裝並登入 `tailscale` CLI。
- `tailscale.mode: "funnel"` 拒絕啟動，除非認證模式設為 `password` 以避免公開暴露。
- 如果您希望 OpenClaw 在關閉時撤銷 `tailscale serve` 或 `tailscale funnel` 設定，請設置 `gateway.tailscale.resetOnExit`。
- `gateway.bind: "tailnet"` 是直接的 Tailnet 綁定（無 HTTPS，無 Serve/Funnel）。
- `gateway.bind: "auto"` 偏好回環；如果您只想要 Tailnet，請使用 `tailnet`。
- Serve/Funnel 只暴露 **Gateway 控制 UI + WS**。節點通過相同的 Gateway WS 端點連接，因此 Serve 可以用於節點訪問。

## 瀏覽器控制（遠端閘道 + 本地瀏覽器）

如果您在一台機器上執行 Gateway，但想要在另一台機器上驅動瀏覽器，請在瀏覽器機器上執行 **node host**，並確保兩者都在同一個 tailnet 上。Gateway 將會將瀏覽器的操作代理到 node；不需要單獨的控制伺服器或 Serve URL。

避免使用 Funnel 進行瀏覽器控制；將節點配對視為操作員訪問。

## Tailscale 前置條件 + 限制

- Serve 需要為您的 tailnet 啟用 HTTPS；如果缺少，CLI 會提示您。
- Serve 會注入 Tailscale 身份標頭；而 Funnel 則不會。
- Funnel 需要 Tailscale v1.38.3 以上版本、MagicDNS、啟用 HTTPS，以及一個 funnel 節點屬性。
- Funnel 僅支援透過 TLS 的端口 `443`、`8443` 和 `10000`。
- 在 macOS 上，Funnel 需要開源的 Tailscale 應用變體。

## Learn more

- Tailscale Serve 概述: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve` 指令: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tailscale Funnel 概述: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel` 指令: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
