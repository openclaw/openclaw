---
summary: "`openclaw qr` CLI 参考（生成 iOS 配对二维码和设置码）"
read_when:
  - 你想快速将 iOS 应用与 Gateway 配对
  - 你需要设置码输出用于远程/手动分享
title: "qr"
---

# `openclaw qr`

根据当前 Gateway 配置生成 iOS 配对二维码和设置码。

## 用法

```bash
openclaw qr
openclaw qr --setup-code-only
openclaw qr --json
openclaw qr --remote
openclaw qr --url wss://gateway.example/ws --token '<token>'
```

## 选项

- `--remote`: 使用配置中的 `gateway.remote.url` 和远程 token/password
- `--url <url>`: 覆盖 payload 中使用的 gateway URL
- `--public-url <url>`: 覆盖 payload 中使用的公共 URL
- `--token <token>`: 覆盖 payload 中的 gateway token
- `--password <password>`: 覆盖 payload 中的 gateway password
- `--setup-code-only`: 仅打印设置码
- `--no-ascii`: 跳过 ASCII 二维码渲染
- `--json`: 输出 JSON (`setupCode`, `gatewayUrl`, `auth`, `urlSource`)

## 注意事项

- `--token` 和 `--password` 互斥，不能同时使用。
- 使用 `--remote` 时，如果有效激活的远程凭证配置为 SecretRefs 且你未传递 `--token` 或 `--password`，命令会从活动的 gateway 快照中解析它们。如果 gateway 不可用，命令会快速失败。
- 不使用 `--remote` 时，当密码认证可生效时（显式 `gateway.auth.mode="password"` 或推断的密码模式且 auth/env 中无胜出的 token），本地 `gateway.auth.password` SecretRefs 会被解析，且未传递 CLI auth 覆盖。
- Gateway 版本偏差注意：此命令路径需要支持 `secrets.resolve` 的 gateway；旧版 gateway 返回 unknown-method 错误。
- 扫描后，使用以下命令批准设备配对：
  - `openclaw devices list`
  - `openclaw devices approve <requestId>`
