---
read_when:
  - 将 Gateway网关控制界面暴露到 localhost 之外
  - 自动化 tailnet 或公共仪表盘访问
summary: 为 Gateway网关仪表盘集成 Tailscale Serve/Funnel
title: Tailscale
x-i18n:
  generated_at: "2026-02-01T20:39:04Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: c900c70a9301f2909a3a29a6fb0e6edfc8c18dba443f2e71b9cfadbc58167911
  source_path: gateway/tailscale.md
  workflow: 14
---

# Tailscale（Gateway网关仪表盘）

OpenClaw 可以为 Gateway网关仪表盘和 WebSocket 端口自动配置 Tailscale **Serve**（tailnet）或 **Funnel**（公网）。这样 Gateway网关仍然绑定在 local loopback 上，而由 Tailscale 提供 HTTPS、路由以及（对于 Serve）身份头信息。

## 模式

- `serve`：通过 `tailscale serve` 仅限 Tailnet 的 Serve。Gateway网关保持在 `127.0.0.1` 上。
- `funnel`：通过 `tailscale funnel` 提供公网 HTTPS。OpenClaw 要求设置共享密码。
- `off`：默认（不启用 Tailscale 自动化）。

## 认证

设置 `gateway.auth.mode` 以控制握手方式：

- `token`（设置了 `OPENCLAW_GATEWAY_TOKEN` 时的默认值）
- `password`（通过 `OPENCLAW_GATEWAY_PASSWORD` 或配置文件设置的共享密钥）

当 `tailscale.mode = "serve"` 且 `gateway.auth.allowTailscale` 为 `true` 时，有效的 Serve 代理请求可以通过 Tailscale 身份头（`tailscale-user-login`）进行认证，无需提供令牌/密码。OpenClaw 通过本地 Tailscale 守护进程（`tailscale whois`）解析 `x-forwarded-for` 地址，并将其与头信息匹配来验证身份。OpenClaw 仅在请求来自 local loopback 且带有 Tailscale 的 `x-forwarded-for`、`x-forwarded-proto` 和 `x-forwarded-host` 头时，才将其视为 Serve 请求。
要强制使用显式凭据，请设置 `gateway.auth.allowTailscale: false` 或强制指定 `gateway.auth.mode: "password"`。

## 配置示例

### 仅限 Tailnet（Serve）

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

打开：`https://<magicdns>/`（或你配置的 `gateway.controlUi.basePath`）

### 仅限 Tailnet（绑定到 Tailnet IP）

当你希望 Gateway网关直接监听 Tailnet IP（不使用 Serve/Funnel）时，使用此方式。

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

从另一台 Tailnet 设备连接：

- 控制界面：`http://<tailscale-ip>:18789/`
- WebSocket：`ws://<tailscale-ip>:18789`

注意：在此模式下，local loopback（`http://127.0.0.1:18789`）将**不可用**。

### 公网（Funnel + 共享密码）

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

建议使用 `OPENCLAW_GATEWAY_PASSWORD` 而非将密码提交到磁盘。

## CLI 示例

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## 注意事项

- Tailscale Serve/Funnel 要求已安装 `tailscale` CLI 并已登录。
- `tailscale.mode: "funnel"` 在认证模式不是 `password` 时将拒绝启动，以避免公网暴露。
- 如果你希望 OpenClaw 在关闭时撤销 `tailscale serve` 或 `tailscale funnel` 配置，请设置 `gateway.tailscale.resetOnExit`。
- `gateway.bind: "tailnet"` 是直接绑定 Tailnet（无 HTTPS，无 Serve/Funnel）。
- `gateway.bind: "auto"` 优先使用 local loopback；如果你只需要 Tailnet，请使用 `tailnet`。
- Serve/Funnel 仅暴露 **Gateway网关控制界面 + WS**。节点通过同一个 Gateway网关 WS 端点连接，因此 Serve 可用于节点访问。

## 浏览器控制（远程 Gateway网关 + 本地浏览器）

如果你在一台机器上运行 Gateway网关，但希望在另一台机器上驱动浏览器，请在浏览器所在机器上运行一个**节点主机**，并将两者保持在同一个 tailnet 中。Gateway网关会将浏览器操作代理到节点；无需单独的控制服务器或 Serve URL。

避免将 Funnel 用于浏览器控制；应将节点配对视为操作员级别的访问。

## Tailscale 前置条件 + 限制

- Serve 要求你的 tailnet 已启用 HTTPS；如果未启用，CLI 会提示。
- Serve 会注入 Tailscale 身份头；Funnel 不会。
- Funnel 要求 Tailscale v1.38.3+、MagicDNS、已启用 HTTPS 以及 funnel 节点属性。
- Funnel 仅支持通过 TLS 使用端口 `443`、`8443` 和 `10000`。
- macOS 上的 Funnel 要求使用开源版本的 Tailscale 应用。

## 了解更多

- Tailscale Serve 概览：https://tailscale.com/kb/1312/serve
- `tailscale serve` 命令：https://tailscale.com/kb/1242/tailscale-serve
- Tailscale Funnel 概览：https://tailscale.com/kb/1223/tailscale-funnel
- `tailscale funnel` 命令：https://tailscale.com/kb/1311/tailscale-funnel
