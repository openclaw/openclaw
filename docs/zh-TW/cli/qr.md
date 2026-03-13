---
summary: CLI reference for `openclaw qr` (generate iOS pairing QR + setup code)
read_when:
  - You want to pair the iOS app with a gateway quickly
  - You need setup-code output for remote/manual sharing
title: qr
---

# `openclaw qr`

從您目前的 Gateway 設定產生 iOS 配對 QR 碼與設定碼。

## 使用說明

```bash
openclaw qr
openclaw qr --setup-code-only
openclaw qr --json
openclaw qr --remote
openclaw qr --url wss://gateway.example/ws
```

## 選項

- `--remote`：使用 `gateway.remote.url` 加上來自設定的遠端 token/密碼
- `--url <url>`：覆寫 payload 中使用的 gateway URL
- `--public-url <url>`：覆寫 payload 中使用的公開 URL
- `--token <token>`：覆寫 bootstrap 流程認證所使用的 gateway token
- `--password <password>`：覆寫 bootstrap 流程認證所使用的 gateway 密碼
- `--setup-code-only`：僅列印設定程式碼
- `--no-ascii`：跳過 ASCII QR 碼渲染
- `--json`：輸出 JSON (`setupCode`、`gatewayUrl`、`auth`、`urlSource`)

## 備註

- `--token` 和 `--password` 互斥。
- 設定程式碼本身現在攜帶一個不透明的短期 `bootstrapToken`，而非共用的 gateway token/密碼。
- 使用 `--remote` 時，若有效的遠端憑證以 SecretRefs 形式設定，且未傳入 `--token` 或 `--password`，指令會從有效的 gateway 快照中解析它們。若 gateway 不可用，指令會快速失敗。
- 若未使用 `--remote`，且未傳入 CLI 認證覆寫，則會解析本地 gateway 認證 SecretRefs：
  - `gateway.auth.token` 會在 token 認證可勝出的情況下解析（明確的 `gateway.auth.mode="token"` 或推斷模式中無密碼來源勝出）。
  - `gateway.auth.password` 會在密碼認證可勝出的情況下解析（明確的 `gateway.auth.mode="password"` 或推斷模式中無勝出 token 來自認證/環境）。
- 若同時設定了 `gateway.auth.token` 和 `gateway.auth.password`（包含 SecretRefs），且未設定 `gateway.auth.mode`，則設定程式碼解析會失敗，直到明確設定模式。
- Gateway 版本差異說明：此指令路徑需要支援 `secrets.resolve` 的 gateway；舊版 gateway 會回傳未知方法錯誤。
- 掃描後，使用以下指令批准裝置配對：
  - `openclaw devices list`
  - `openclaw devices approve <requestId>`
