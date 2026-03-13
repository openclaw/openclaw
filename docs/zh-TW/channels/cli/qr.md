---
summary: CLI reference for `openclaw qr` (generate iOS pairing QR + setup code)
read_when:
  - You want to pair the iOS app with a gateway quickly
  - You need setup-code output for remote/manual sharing
title: qr
---

# `openclaw qr`

從您當前的 Gateway 設定生成 iOS 配對 QR 碼和設置程式碼。

## 使用方式

```bash
openclaw qr
openclaw qr --setup-code-only
openclaw qr --json
openclaw qr --remote
openclaw qr --url wss://gateway.example/ws
```

## Options

- `--remote`: 使用 `gateway.remote.url` 加上來自設定的遠端 token/密碼
- `--url <url>`: 覆蓋在有效載荷中使用的閘道 URL
- `--public-url <url>`: 覆蓋在有效載荷中使用的公共 URL
- `--token <token>`: 覆蓋啟動流程認證的閘道 token
- `--password <password>`: 覆蓋啟動流程認證的閘道密碼
- `--setup-code-only`: 僅列印設置程式碼
- `--no-ascii`: 跳過 ASCII QR 渲染
- `--json`: 發出 JSON (`setupCode`, `gatewayUrl`, `auth`, `urlSource`)

## Notes

- `--token` 和 `--password` 是互斥的。
- 設定程式碼本身現在攜帶一個不透明的短期 `bootstrapToken`，而不是共享的網關 token/密碼。
- 使用 `--remote` 時，如果有效的遠端憑證被設定為 SecretRefs，且您未傳遞 `--token` 或 `--password`，則命令會從活動的網關快照中解析它們。如果網關不可用，命令會快速失敗。
- 在未傳遞 CLI 認證覆蓋的情況下，當沒有傳遞 `--remote` 時，本地網關認證 SecretRefs 會被解析：
  - `gateway.auth.token` 在 token 認證可以獲勝時解析（明確的 `gateway.auth.mode="token"` 或推斷模式下沒有密碼來源獲勝）。
  - `gateway.auth.password` 在密碼認證可以獲勝時解析（明確的 `gateway.auth.mode="password"` 或推斷模式下沒有來自認證/環境的獲勝 token）。
- 如果同時設定了 `gateway.auth.token` 和 `gateway.auth.password`（包括 SecretRefs），且 `gateway.auth.mode` 未設置，則設定程式碼解析會失敗，直到模式被明確設置。
- 網關版本不一致注意：此命令路徑需要支援 `secrets.resolve` 的網關；舊版網關會返回未知方法錯誤。
- 掃描後，請批准設備配對：
  - `openclaw devices list`
  - `openclaw devices approve <requestId>`
