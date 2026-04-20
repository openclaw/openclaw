---
summary: "网关 Web 界面：控制 UI、绑定模式和安全性"
read_when:
  - 您想通过 Tailscale 访问网关
  - 您想要浏览器控制 UI 和配置编辑
title: "Web"
---

# Web（网关）

网关从与网关 WebSocket 相同的端口提供一个小型**浏览器控制 UI**（Vite + Lit）：

- 默认：`http://<host>:18789/`
- 可选前缀：设置 `gateway.controlUi.basePath`（例如 `/openclaw`）

功能位于 [控制 UI](/web/control-ui)。
本页重点介绍绑定模式、安全性和面向 Web 的界面。

## Webhooks

当 `hooks.enabled=true` 时，网关还在同一 HTTP 服务器上暴露一个小型 webhook 端点。
有关认证和有效负载，请参阅 [网关配置](/gateway/configuration) → `hooks`。

## 配置（默认开启）

当资产存在时（`dist/control-ui`），控制 UI**默认启用**。
您可以通过配置控制它：

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath 可选
  },
}
```

## Tailscale 访问

### 集成 Serve（推荐）

将网关保持在环回上，让 Tailscale Serve 代理它：

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

然后启动网关：

```bash
openclaw gateway
```

打开：

- `https://<magicdns>/`（或您配置的 `gateway.controlUi.basePath`）

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

然后启动网关（这个非环回示例使用共享密钥令牌认证）：

```bash
openclaw gateway
```

打开：

- `http://<tailscale-ip>:18789/`（或您配置的 `gateway.controlUi.basePath`）

### 公共互联网（Funnel）

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // 或 OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## 安全注意事项

- 默认需要网关认证（令牌、密码、受信任代理或启用时的 Tailscale Serve 身份标头）。
- 非环回绑定仍然**需要**网关认证。实际上，这意味着令牌/密码认证或带有 `gateway.auth.mode: "trusted-proxy"` 的身份感知反向代理。
- 向导默认创建共享密钥认证，通常会生成
  网关令牌（即使在环回上）。
- 在共享密钥模式下，UI 发送 `connect.params.auth.token` 或
  `connect.params.auth.password`。
- 在身份承载模式下，例如 Tailscale Serve 或 `trusted-proxy`，
  WebSocket 认证检查从请求标头中满足。
- 对于非环回控制 UI 部署，明确设置 `gateway.controlUi.allowedOrigins`
  （完整来源）。没有它，默认情况下网关启动被拒绝。
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true` 启用
  Host 标头来源回退模式，但这是一种危险的安全降级。
- 使用 Serve 时，当 `gateway.auth.allowTailscale` 为 `true` 时，Tailscale 身份标头可以满足控制 UI/WebSocket 认证
  （不需要令牌/密码）。
  HTTP API 端点不使用这些 Tailscale 身份标头；它们遵循
  网关的正常 HTTP 认证模式。设置
  `gateway.auth.allowTailscale: false` 需要显式凭据。请参阅
  [Tailscale](/gateway/tailscale) 和 [安全](/gateway/security)。这种
  无令牌流程假设网关主机是受信任的。
- `gateway.tailscale.mode: "funnel"` 需要 `gateway.auth.mode: "password"`（共享密码）。

## 构建 UI

网关从 `dist/control-ui` 提供静态文件。使用以下命令构建它们：

```bash
pnpm ui:build
```
