---
summary: "Integrated Tailscale Serve/Funnel for the Gateway dashboard"
read_when:
  - Exposing the Gateway Control UI outside localhost
  - Automating tailnet or public dashboard access
title: "Tailscale"
---

# Tailscale (Gateway dashboard)

OpenClaw can auto-configure Tailscale **Serve** (tailnet) or **Funnel** (public) for the
Gateway dashboard and WebSocket port. This keeps the Gateway bound to loopback while
Tailscale provides HTTPS, routing, and (for Serve) identity headers.

## Modes

- `serve`: Tailnet-only Serve via `tailscale serve`. The gateway stays on `127.0.0.1`.
- `funnel`: Public HTTPS via `tailscale funnel`. OpenClaw requires a shared password.
- `off`: Default (no Tailscale automation).

## Auth

Set `gateway.auth.mode` to control the handshake:

- `token` (default when `OPENCLAW_GATEWAY_TOKEN` is set)
- `password` (shared secret via `OPENCLAW_GATEWAY_PASSWORD` or config)

When `tailscale.mode = "serve"` and `gateway.auth.allowTailscale` is `true`,
Control UI/WebSocket auth can use Tailscale identity headers
(`tailscale-user-login`) without supplying a token/password. OpenClaw verifies
the identity by resolving the `x-forwarded-for` address via the local Tailscale
daemon (`tailscale whois`) and matching it to the header before accepting it.
OpenClaw only treats a request as Serve when it arrives from loopback with
Tailscale's `x-forwarded-for`, `x-forwarded-proto`, and `x-forwarded-host`
headers.
HTTP API endpoints (for example `/v1/*`, `/tools/invoke`, and `/api/channels/*`)
still require token/password auth.
This tokenless flow assumes the gateway host is trusted. If untrusted local code
may run on the same host, disable `gateway.auth.allowTailscale` and require
token/password auth instead.
To require explicit credentials, set `gateway.auth.allowTailscale: false` or
force `gateway.auth.mode: "password"`.

## Config examples

### Tailnet-only (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Open: `https://<magicdns>/` (or your configured `gateway.controlUi.basePath`)

### Tailnet-only (bind to Tailnet IP)

Use this when you want the Gateway to listen directly on the Tailnet IP (no Serve/Funnel).

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

Connect from another Tailnet device:

- Control UI: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

Note: loopback (`http://127.0.0.1:18789`) will **not** work in this mode.

### Public internet (Funnel + shared password)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

Prefer `OPENCLAW_GATEWAY_PASSWORD` over committing a password to disk.

## Custom control server (Headscale)

OpenClaw supports connecting to a self-hosted Tailscale-compatible control server such as
[Headscale](https://headscale.net). Set `gateway.tailscale.controlUrl` to your control
server's base URL:

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
    tailscale: {
      controlUrl: "https://headscale.example.com",
    },
  },
}
```

**Important limitations when using a custom control server:**

- `tailscale.mode: "serve"` and `tailscale.mode: "funnel"` are **not supported** with a
  custom control server. Tailscale Serve and Funnel require official Tailscale infrastructure.
  OpenClaw will refuse to start if you set `mode: "serve"` or `mode: "funnel"` together with
  `controlUrl`. Use `gateway.bind: "tailnet"` (direct Tailnet IP bind) instead.
- `tailscale.mode: "off"` (the default) is fully compatible with custom control servers.

### Connecting to your Headscale server

Before starting the gateway, authenticate the machine against your Headscale server:

```bash
tailscale up --login-server https://headscale.example.com
```

After the machine is registered and approved in Headscale, start the gateway normally:

```bash
openclaw gateway run --bind tailnet --tailscale-control-url https://headscale.example.com
```

The `--tailscale-control-url` flag (or `gateway.tailscale.controlUrl` in config) records the
control server URL. Serve and Funnel modes are rejected when this option is set.

## CLI examples

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
openclaw gateway --bind tailnet --tailscale-control-url https://headscale.example.com
```

## Notes

- Tailscale Serve/Funnel requires the `tailscale` CLI to be installed and logged in.
- `tailscale.mode: "funnel"` refuses to start unless auth mode is `password` to avoid public exposure.
- Set `gateway.tailscale.resetOnExit` if you want OpenClaw to undo `tailscale serve`
  or `tailscale funnel` configuration on shutdown.
- `gateway.bind: "tailnet"` is a direct Tailnet bind (no HTTPS, no Serve/Funnel).
- `gateway.bind: "auto"` prefers loopback; use `tailnet` if you want Tailnet-only.
- Serve/Funnel only expose the **Gateway control UI + WS**. Nodes connect over
  the same Gateway WS endpoint, so Serve can work for node access.

## Browser control (remote Gateway + local browser)

If you run the Gateway on one machine but want to drive a browser on another machine,
run a **node host** on the browser machine and keep both on the same tailnet.
The Gateway will proxy browser actions to the node; no separate control server or Serve URL needed.

Avoid Funnel for browser control; treat node pairing like operator access.

## Tailscale prerequisites + limits

- Serve requires HTTPS enabled for your tailnet; the CLI prompts if it is missing.
- Serve injects Tailscale identity headers; Funnel does not.
- Funnel requires Tailscale v1.38.3+, MagicDNS, HTTPS enabled, and a funnel node attribute.
- Funnel only supports ports `443`, `8443`, and `10000` over TLS.
- Funnel on macOS requires the open-source Tailscale app variant.
- Tailscale Serve and Funnel are not available with custom control servers (e.g., Headscale).
  See [Headscale feature support](https://headscale.net/stable/about/features/) for details.

## Learn more

- Tailscale Serve overview: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve` command: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tailscale Funnel overview: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel` command: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
- Headscale: [https://headscale.net](https://headscale.net)
