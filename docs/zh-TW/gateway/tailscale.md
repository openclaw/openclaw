---
summary: "為 Gateway儀表板整合 Tailscale Serve/Funnel"
read_when:
  - 在 localhost 之外暴露 Gateway控制 UI
  - 自動化 tailnet 或公共儀表板存取
title: "Tailscale"
---

# Tailscale (Gateway儀表板)

OpenClaw 可以為 Gateway儀表板和 WebSocket 埠自動設定 Tailscale **Serve** (tailnet) 或 **Funnel** (公共)。這使得 Gateway保持綁定到 local loopback，同時 Tailscale 提供 HTTPS、路由以及 (對於 Serve) 身份標頭。

## 模式

- `serve`: 僅限 Tailnet 的 Serve，透過 `tailscale serve`。Gateway維持在 `127.0.0.1` 上。
- `funnel`: 透過 `tailscale funnel` 的公共 HTTPS。OpenClaw 需要共享密碼。
- `off`: 預設 (無 Tailscale 自動化)。

## 憑證

設定 `gateway.auth.mode` 來控制交握：

- `token` (當設定 `OPENCLAW_GATEWAY_TOKEN` 時為預設)
- `password` (透過 `OPENCLAW_GATEWAY_PASSWORD` 或設定的共享密碼)

當 `tailscale.mode = "serve"` 且 `gateway.auth.allowTailscale` 為 `true` 時，
有效的 Serve 代理請求可以透過 Tailscale 身份標頭 (`tailscale-user-login`) 進行憑證驗證，無需提供權杖/密碼。OpenClaw 透過 local Tailscale 守護程式 (`tailscale whois`) 解析 `x-forwarded-for` 位址並將其與標頭匹配後才接受。
OpenClaw 僅在請求從 local loopback 到達並帶有 Tailscale 的 `x-forwarded-for`、`x-forwarded-proto` 和 `x-forwarded-host` 標頭時才將其視為 Serve 請求。
若要要求明確的憑證，請設定 `gateway.auth.allowTailscale: false` 或強制 `gateway.auth.mode: "password"`。

## 設定範例

### 僅限 Tailnet (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

開啟：`https://<magicdns>/` (或您設定的 `gateway.controlUi.basePath`)

### 僅限 Tailnet (綁定至 Tailnet IP)

當您希望 Gateway直接監聽 Tailnet IP 時使用此方式 (無 Serve/Funnel)。

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

從另一個 Tailnet 裝置連線：

- 控制 UI：`http://<tailscale-ip>:18789/`
- WebSocket：`ws://<tailscale-ip>:18789`

注意：在此模式下 local loopback (`http://127.0.0.1:18789`) 將**無法**運作。

### 公共網際網路 (Funnel + 共享密碼)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

優先使用 `OPENCLAW_GATEWAY_PASSWORD`，而非將密碼提交到磁碟。

## CLI 範例

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## 注意事項

- Tailscale Serve/Funnel 需要安裝並登入 `tailscale` CLI。
- `tailscale.mode: "funnel"` 除非憑證模式為 `password`，否則拒絕啟動，以避免公共暴露。
- 如果您希望 OpenClaw 在關閉時復原 `tailscale serve` 或 `tailscale funnel` 設定，請設定 `gateway.tailscale.resetOnExit`。
- `gateway.bind: "tailnet"` 是直接的 Tailnet 綁定 (無 HTTPS，無 Serve/Funnel)。
- `gateway.bind: "auto"` 偏好 local loopback；如果您只想要 Tailnet，請使用 `tailnet`。
- Serve/Funnel 僅暴露 **Gateway控制 UI + WS**。節點透過相同的 Gateway WS 端點連線，因此 Serve 可用於節點存取。

## 瀏覽器控制 (遠端 Gateway + 本機瀏覽器)

如果您在一台機器上執行 Gateway，但想在另一台機器上驅動瀏覽器，
請在瀏覽器機器上執行一個**節點主機**並讓兩者保持在相同的 tailnet 上。
Gateway會將瀏覽器動作代理到節點；不需要單獨的控制伺服器或 Serve URL。

避免將 Funnel 用於瀏覽器控制；將節點配對視為操作者存取。

## Tailscale 先決條件 + 限制

- Serve 需要為您的 tailnet 啟用 HTTPS；如果缺少，CLI 會提示。
- Serve 注入 Tailscale 身份標頭；Funnel 不會。
- Funnel 需要 Tailscale v1.38.3+、MagicDNS、啟用 HTTPS 和一個 Funnel 節點屬性。
- Funnel 僅支援透過 TLS 的 `443`、`8443` 和 `10000` 埠。
- macOS 上的 Funnel 需要開源的 Tailscale 應用變體。

## 了解更多

- Tailscale Serve 概述：[https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve` 命令：[https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tailscale Funnel 概述：[https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel` 命令：[https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
