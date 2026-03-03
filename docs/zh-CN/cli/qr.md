---
summary: "`openclaw qr` CLI 参考（生成 iOS 配对二维码和设置码）"
read_when:
  - 想要快速将 iOS 应用与 Gateway 配对
  - 需要设置码输出用于远程/手动分享
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

- `--remote`：使用配置中的 `gateway.remote.url` 及远程 token/password
- `--url <url>`：覆盖载荷中使用的 Gateway URL
- `--public-url <url>`：覆盖载荷中使用的公共 URL
- `--token <token>`：覆盖载荷中的 Gateway token
- `--password <password>`：覆盖载荷中的 Gateway password
- `--setup-code-only`：仅打印设置码
- `--no-ascii`：跳过 ASCII 二维码渲染
- `--json`：输出 JSON（`setupCode`、`gatewayUrl`、`auth`、`urlSource`）

## 说明

- `--token` 和 `--password` 互斥。
- 使用 `--remote` 时，如果有效的远程凭证配置为 SecretRef 且未传入 `--token` 或 `--password`，命令会从活动的 Gateway 快照解析。如果 Gateway 不可用，命令会快速失败。
- 不使用 `--remote` 时，当密码认证可以胜出（显式 `gateway.auth.mode="password"` 或推断的密码模式且无来自 auth/env 的胜出 token）且未传入 CLI 认证覆盖时，会解析本地 `gateway.auth.password` SecretRef。
- Gateway 版本差异注意：此命令路径需要支持 `secrets.resolve` 的 Gateway；旧版 Gateway 会返回未知方法错误。
- 扫描后，通过以下命令批准设备配对：
  - `openclaw devices list`
  - `openclaw devices approve <requestId>`
