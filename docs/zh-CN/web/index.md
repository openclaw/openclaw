---
read_when:
  - 你想通过 Tailscale 访问 Gateway网关
  - 你想使用浏览器控制 UI 和配置编辑
summary: Gateway网关 Web 界面：控制 UI、绑定模式与安全
title: Web
x-i18n:
  generated_at: "2026-02-01T21:44:11Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 4da8bc9831018c482ac918a759b9739f75ca130f70993f81911818bc60a685d1
  source_path: web/index.md
  workflow: 15
---

# Web（Gateway网关）

Gateway网关在与 Gateway网关 WebSocket 相同的端口上提供一个小型**浏览器控制 UI**（Vite + Lit）：

- 默认：`http://<host>:18789/`
- 可选前缀：设置 `gateway.controlUi.basePath`（例如 `/openclaw`）

功能详情请参阅[控制 UI](/web/control-ui)。
本页重点介绍绑定模式、安全和面向 Web 的界面。

## Webhook

当 `hooks.enabled=true` 时，Gateway网关还会在同一 HTTP 服务器上暴露一个小型 webhook 端点。
请参阅 [Gateway网关配置](/gateway/configuration) → `hooks` 了解认证和负载。

## 配置（默认启用）

当资源文件存在时（`dist/control-ui`），控制 UI **默认启用**。
你可以通过配置控制它：

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath 可选
  },
}
```

## Tailscale 访问

### 集成 Serve（推荐）

将 Gateway网关保持在 local loopback 上，让 Tailscale Serve 代理它：

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

然后启动 Gateway网关：

```bash
openclaw gateway
```

打开：

- `https://<magicdns>/`（或你配置的 `gateway.controlUi.basePath`）

### Tailnet 绑定 + 令牌

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

然后启动 Gateway网关（非 local loopback 绑定需要令牌）：

```bash
openclaw gateway
```

打开：

- `http://<tailscale-ip>:18789/`（或你配置的 `gateway.controlUi.basePath`）

### 公网访问（Funnel）

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // 或 OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## 安全说明

- Gateway网关认证默认必需（令牌/密码或 Tailscale 身份头）。
- 非 local loopback 绑定仍然**需要**共享令牌/密码（`gateway.auth` 或环境变量）。
- 向导默认生成 Gateway网关令牌（即使在 local loopback 上）。
- UI 发送 `connect.params.auth.token` 或 `connect.params.auth.password`。
- 使用 Serve 时，当 `gateway.auth.allowTailscale` 为 `true` 时，Tailscale 身份头可满足认证要求（无需令牌/密码）。设置 `gateway.auth.allowTailscale: false` 以要求显式凭据。请参阅 [Tailscale](/gateway/tailscale) 和[安全](/gateway/security)。
- `gateway.tailscale.mode: "funnel"` 需要 `gateway.auth.mode: "password"`（共享密码）。

## 构建 UI

Gateway网关从 `dist/control-ui` 提供静态文件。使用以下命令构建：

```bash
pnpm ui:build # 首次运行时自动安装 UI 依赖
```
