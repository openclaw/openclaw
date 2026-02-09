---
summary: "為 Gateway 儀表板整合 Tailscale Serve／Funnel"
read_when:
  - 在 localhost 之外公開 Gateway 控制 UI
  - 自動化 tailnet 或公開儀表板存取
title: "Tailscale"
---

# Tailscale（Gateway 儀表板）

OpenClaw 可為
Gateway 儀表板與 WebSocket 連接埠自動設定 Tailscale **Serve**（tailnet）或 **Funnel**（公開）。
這能讓 Gateway 綁定在 loopback，同時由 Tailscale 提供 HTTPS、路由，以及（對 Serve 而言）身分識別標頭。 This keeps the Gateway bound to loopback while
Tailscale provides HTTPS, routing, and (for Serve) identity headers.

## 模式

- `serve`: Tailnet-only Serve via `tailscale serve`. The gateway stays on `127.0.0.1`.
- `funnel`：透過 `tailscale funnel` 提供公開 HTTPS。OpenClaw 需要共用密碼。 OpenClaw requires a shared password.
- `off`：預設（不進行 Tailscale 自動化）。

## Auth

設定 `gateway.auth.mode` 以控制交握：

- `token`（當設定 `OPENCLAW_GATEWAY_TOKEN` 時的預設）
- `password`（透過 `OPENCLAW_GATEWAY_PASSWORD` 或設定檔的共用密鑰）

當 `tailscale.mode = "serve"` 且 `gateway.auth.allowTailscale` 為 `true` 時，
有效的 Serve 代理請求可透過 Tailscale 身分識別標頭
（`tailscale-user-login`）進行身分驗證，而無需提供權杖／密碼。OpenClaw 會
透過本機 Tailscale
daemon（`tailscale whois`）解析 `x-forwarded-for` 位址，並與標頭比對後才接受。
OpenClaw 只會在請求從 loopback 進入，且帶有 Tailscale 的 `x-forwarded-for`、`x-forwarded-proto` 與 `x-forwarded-host`
標頭時，才將其視為 Serve。
若要要求明確的認證，請設定 `gateway.auth.allowTailscale: false`，或
強制 `gateway.auth.mode: "password"`。 OpenClaw verifies
the identity by resolving the `x-forwarded-for` address via the local Tailscale
daemon (`tailscale whois`) and matching it to the header before accepting it.
OpenClaw only treats a request as Serve when it arrives from loopback with
Tailscale’s `x-forwarded-for`, `x-forwarded-proto`, and `x-forwarded-host`
headers.
To require explicit credentials, set `gateway.auth.allowTailscale: false` or
force `gateway.auth.mode: "password"`.

## 設定範例

### 僅限 tailnet（Serve）

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

開啟：`https://<magicdns>/`（或你設定的 `gateway.controlUi.basePath`）

### 僅限 tailnet（綁定至 Tailnet IP）

當你希望 Gateway 直接監聽 Tailnet IP（不使用 Serve／Funnel）時使用。

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

從另一台 Tailnet 裝置連線：

- 控制 UI：`http://<tailscale-ip>:18789/`
- WebSocket：`ws://<tailscale-ip>:18789`

注意：此模式下，loopback（`http://127.0.0.1:18789`）將 **無法** 使用。

### 公開網際網路（Funnel + 共用密碼）

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

建議使用 `OPENCLAW_GATEWAY_PASSWORD`，避免將密碼提交到磁碟。

## CLI 範例

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## 注意事項

- Tailscale Serve／Funnel 需要已安裝並登入 `tailscale` CLI。
- 為避免公開暴露，`tailscale.mode: "funnel"` 在 auth 模式不是 `password` 時會拒絕啟動。
- 若你希望 OpenClaw 在關閉時復原 `tailscale serve`
  或 `tailscale funnel` 的設定，請設定 `gateway.tailscale.resetOnExit`。
- `gateway.bind: "tailnet"` 為直接綁定 Tailnet（無 HTTPS、無 Serve／Funnel）。
- `gateway.bind: "auto"` 偏好 loopback；若需要僅限 Tailnet，請使用 `tailnet`。
- Serve／Funnel 只會公開 **Gateway 控制 UI + WS**。節點會透過相同的 Gateway WS 端點連線，因此 Serve 也可用於節點存取。 Nodes connect over
  the same Gateway WS endpoint, so Serve can work for node access.

## 瀏覽器控制（遠端 Gateway + 本機瀏覽器）

若你在一台機器上執行 Gateway，但希望在另一台機器上操作瀏覽器，
請在瀏覽器機器上執行 **node host**，並讓兩者位於同一個 tailnet。
Gateway 會將瀏覽器動作代理到節點；不需要額外的控制伺服器或 Serve URL。
The Gateway will proxy browser actions to the node; no separate control server or Serve URL needed.

避免使用 Funnel 進行瀏覽器控制；請將節點配對視為操作員存取。

## Tailscale prerequisites + limits

- Serve 需要為你的 tailnet 啟用 HTTPS；若缺少，CLI 會提示。
- Serve 會注入 Tailscale 身分識別標頭；Funnel 不會。
- Funnel 需要 Tailscale v1.38.3+、MagicDNS、已啟用 HTTPS，以及 funnel 節點屬性。
- Funnel 透過 TLS 僅支援連接埠 `443`、`8443` 與 `10000`。
- macOS 上的 Funnel 需要開放原始碼的 Tailscale App 變體。

## Learn more

- Tailscale Serve 概覽：[https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve` 指令：[https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tailscale Funnel 概覽：[https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel` 指令：[https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
