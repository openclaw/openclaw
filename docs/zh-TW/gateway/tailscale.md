---
summary: "為 Gateway 控制台整合了 Tailscale Serve/Funnel"
read_when:
  - 在 localhost 之外公開 Gateway 控制介面
  - 自動化 tailnet 或公開控制台存取
title: "Tailscale"
---

# Tailscale (Gateway 控制台)

OpenClaw 可以為 Gateway 控制台與 WebSocket 埠自動設定 Tailscale **Serve** (tailnet) 或 **Funnel** (公開)。這能讓 Gateway 保持綁定於 loopback，同時由 Tailscale 提供 HTTPS、路由，以及 (對於 Serve 模式) 身分識別標頭。

## 模式

- `serve`: 僅限 Tailnet 的 Serve，透過 `tailscale serve` 執行。Gateway 仍保持在 `127.0.0.1`。
- `funnel`: 透過 `tailscale funnel` 提供的公開 HTTPS。OpenClaw 要求使用共用密碼。
- `off`: 預設值（不啟用 Tailscale 自動化）。

## 驗證

設定 `gateway.auth.mode` 來控制交握方式：

- `token` (當設定了 `OPENCLAW_GATEWAY_TOKEN` 時的預設值)
- `password` (透過 `OPENCLAW_GATEWAY_PASSWORD` 或設定檔提供的共用密鑰)

當 `tailscale.mode = "serve"` 且 `gateway.auth.allowTailscale` 為 `true` 時，有效的 Serve 代理請求可以透過 Tailscale 身分識別標頭 (`tailscale-user-login`) 進行驗證，而無需提供 token/密碼。OpenClaw 會透過本地 Tailscale 守護程式 (`tailscale whois`) 解析 `x-forwarded-for` 位址來驗證身分，並在接受請求前將其與標頭比對。OpenClaw 僅在請求來自 local loopback 並帶有 Tailscale 的 `x-forwarded-for`、`x-forwarded-proto` 與 `x-forwarded-host` 標頭時，才會將其視為 Serve 請求。
若要要求明確的憑證，請設定 `gateway.auth.allowTailscale: false` 或強制使用 `gateway.auth.mode: "password"`。

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

當您希望 Gateway 直接監聽 Tailnet IP 時使用此選項（不使用 Serve/Funnel）。

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

從另一個 Tailnet 裝置連線：

- 控制介面：`http://<tailscale-ip>:18789/`
- WebSocket：`ws://<tailscale-ip>:18789`

注意：在此模式下，local loopback (`http://127.0.0.1:18789`) 將**無法**運作。

### 公開網際網路 (Funnel + 共用密碼)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

建議使用 `OPENCLAW_GATEWAY_PASSWORD`，而非將密碼寫入磁碟上的設定檔。

## CLI 範例

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## 注意事項

- Tailscale Serve/Funnel 需要安裝 `tailscale` CLI 並已登入。
- 為了避免公開暴露，除非驗證模式為 `password`，否則 `tailscale.mode: "funnel"` 將拒絕啟動。
- 如果您希望 OpenClaw 在關閉時撤銷 `tailscale serve` 或 `tailscale funnel` 設定，請設定 `gateway.tailscale.resetOnExit`。
- `gateway.bind: "tailnet"` 是直接綁定 Tailnet（無 HTTPS，無 Serve/Funnel）。
- `gateway.bind: "auto"` 偏好 loopback；如果您想要僅限 Tailnet，請使用 `tailnet`。
- Serve/Funnel 僅公開 **Gateway 控制介面 + WS**。節點透過相同的 Gateway WS 端點連線，因此 Serve 可用於節點存取。

## 瀏覽器控制 (遠端 Gateway + 本地瀏覽器)

如果您在一台機器上執行 Gateway，但想在另一台機器上驅動瀏覽器，請在該瀏覽器機器上執行 **node host**，並讓兩者處於同一個 tailnet。Gateway 會將瀏覽器操作代理至該節點；無需額外的控制伺服器或 Serve URL。

瀏覽器控制應避免使用 Funnel；請將節點配對視為操作員層級的存取。

## Tailscale 前提條件與限制

- Serve 要求您的 tailnet 啟用 HTTPS；如果未啟用，CLI 會提示。
- Serve 會注入 Tailscale 身分識別標頭；Funnel 則不會。
- Funnel 需要 Tailscale v1.38.3+、MagicDNS、啟用 HTTPS 以及 funnel 節點屬性。
- Funnel 僅支援透過 TLS 使用連接埠 `443`、`8443` 與 `10000`。
- macOS 上的 Funnel 需要開源版本的 Tailscale 應用程式。

## 了解更多

- Tailscale Serve 概覽：[https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve` 指令：[https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tailscale Funnel 概覽：[https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel` 指令：[https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
