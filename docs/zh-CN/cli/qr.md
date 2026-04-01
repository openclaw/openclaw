---
summary: "`openclaw qr` CLI 命令参考（生成 iOS 配对 QR + 设置代码）"
read_when:
  - 需要快速将 iOS 应用与 gateway 配对
  - 需要设置代码输出用于远程/手动分享
title: "qr"
---

# `openclaw qr`

从当前 Gateway 配置生成 iOS 配对 QR 和设置代码。

## 用法

```bash
openclaw qr
openclaw qr --setup-code-only
openclaw qr --json
openclaw qr --remote
openclaw qr --url wss://gateway.example/ws
```

## 选项

- `--remote`: 使用 `gateway.remote.url` 以及配置中的远程 token/password
- `--url <url>`: 覆盖载荷中使用的 gateway URL
- `--public-url <url>`: 覆盖载荷中使用的公共 URL
- `--token <token>`: 覆盖引导流程认证所针对的 gateway token
- `--password <password>`: 覆盖引导流程认证所针对的 gateway password
- `--setup-code-only`: 仅打印设置代码
- `--no-ascii`: 跳过 ASCII QR 渲染
- `--json`: 输出 JSON（`setupCode`、`gatewayUrl`、`auth`、`urlSource`）

## 注意事项

- `--token` 和 `--password` 互斥。
- 设置代码本身现在携带一个不透明的短期 `bootstrapToken`，而不是共享的 gateway token/password。
- 使用 `--remote` 时，如果有效活动的远程凭证配置为 SecretRef 且你未传递 `--token` 或 `--password`，命令会从活动的 gateway 快照解析它们。如果 gateway 不可用，命令会快速失败。
- 不使用 `--remote` 时，当未传递 CLI 认证覆盖时，本地 gateway 认证 SecretRef 会被解析：
  - 当 token 认证可以获胜时（显式 `gateway.auth.mode="token"` 或推断模式下无密码源获胜），`gateway.auth.token` 被解析。
  - 当 password 认证可以获胜时（显式 `gateway.auth.mode="password"` 或推断模式下无获胜 token 来自 auth/env），`gateway.auth.password` 被解析。
- 如果 `gateway.auth.token` 和 `gateway.auth.password` 都配置了（包括 SecretRef）且 `gateway.auth.mode` 未设置，设置代码解析会失败直到显式设置模式。
- Gateway 版本偏差注意：此命令路径需要支持 `secrets.resolve` 的 gateway；旧版 gateway 会返回 unknown-method 错误。
- 扫描后，使用以下命令批准设备配对：
  - `openclaw devices list`
  - `openclaw devices approve <requestId>`