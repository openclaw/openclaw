---
summary: "`openclaw qr` 命令行参考（生成移动配对 QR 码和设置代码）"
read_when:
  - 你想快速将移动节点应用与网关配对
  - 你需要设置代码输出以进行远程/手动共享
title: "qr"
---

# `openclaw qr`

从当前网关配置生成移动配对 QR 码和设置代码。

## 使用方法

```bash
openclaw qr
openclaw qr --setup-code-only
openclaw qr --json
openclaw qr --remote
openclaw qr --url wss://gateway.example/ws
```

## 选项

- `--remote`：优先使用 `gateway.remote.url`；如果未设置，`gateway.tailscale.mode=serve|funnel` 仍可提供远程公共 URL
- `--url <url>`：覆盖负载中使用的网关 URL
- `--public-url <url>`：覆盖负载中使用的公共 URL
- `--token <token>`：覆盖引导流程验证的网关令牌
- `--password <password>`：覆盖引导流程验证的网关密码
- `--setup-code-only`：仅打印设置代码
- `--no-ascii`：跳过 ASCII QR 码渲染
- `--json`：发出 JSON（`setupCode`、`gatewayUrl`、`auth`、`urlSource`）

## 注意

- `--token` 和 `--password` 是互斥的。
- 设置代码本身现在携带一个不透明的短期 `bootstrapToken`，而不是共享的网关令牌/密码。
- 在内置的节点/操作员引导流程中，主节点令牌仍然以 `scopes: []` 落地。
- 如果引导交接也颁发操作员令牌，它仍然受限于引导允许列表：`operator.approvals`、`operator.read`、`operator.talk.secrets`、`operator.write`。
- 引导范围检查带有角色前缀。该操作员允许列表仅满足操作员请求；非操作员角色仍然需要在自己的角色前缀下的范围。
- Tailscale/公共 `ws://` 网关 URL 的移动配对会失败。私有 LAN `ws://` 仍然受支持，但 Tailscale/公共移动路由应使用 Tailscale Serve/Funnel 或 `wss://` 网关 URL。
- 使用 `--remote` 时，OpenClaw 需要 `gateway.remote.url` 或 `gateway.tailscale.mode=serve|funnel`。
- 使用 `--remote` 时，如果有效活动远程凭据配置为 SecretRef 且你未传递 `--token` 或 `--password`，命令会从活动网关快照中解析它们。如果网关不可用，命令会快速失败。
- 没有 `--remote` 时，当未传递 CLI 身份验证覆盖时，会解析本地网关身份验证 SecretRef：
  - 当令牌身份验证可以获胜时（显式 `gateway.auth.mode="token"` 或推断模式，其中没有密码源获胜），`gateway.auth.token` 会解析。
  - 当密码身份验证可以获胜时（显式 `gateway.auth.mode="password"` 或来自 auth/env 没有获胜令牌的推断模式），`gateway.auth.password` 会解析。
- 如果同时配置了 `gateway.auth.token` 和 `gateway.auth.password`（包括 SecretRef）且未设置 `gateway.auth.mode`，设置代码解析会失败，直到明确设置模式。
- 网关版本差异注意：此命令路径需要支持 `secrets.resolve` 的网关；较旧的网关会返回未知方法错误。
- 扫描后，通过以下方式批准设备配对：
  - `openclaw devices list`
  - `openclaw devices approve <requestId>`