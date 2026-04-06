---
read_when:
    - iOSアプリをGateway ゲートウェイにすばやくペアリングしたい場合
    - リモートや手動共有用にセットアップコード出力が必要な場合
summary: '`openclaw qr`（iOSペアリングQRコード + セットアップコードの生成）のCLIリファレンス'
title: qr
x-i18n:
    generated_at: "2026-04-02T07:34:50Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 5ea2888291219804dee48e9e88e572d26207c33989782dd8eb1eae0dda974a4b
    source_path: cli/qr.md
    workflow: 15
---

# `openclaw qr`

現在のGateway ゲートウェイ設定からiOSペアリングQRコードとセットアップコードを生成します。

## 使い方

```bash
openclaw qr
openclaw qr --setup-code-only
openclaw qr --json
openclaw qr --remote
openclaw qr --url wss://gateway.example/ws
```

## オプション

- `--remote`: 設定から `gateway.remote.url` とリモートトークン/パスワードを使用
- `--url <url>`: ペイロードで使用するGateway ゲートウェイURLを上書き
- `--public-url <url>`: ペイロードで使用するパブリックURLを上書き
- `--token <token>`: ブートストラップフローで認証に使用するGateway ゲートウェイトークンを上書き
- `--password <password>`: ブートストラップフローで認証に使用するGateway ゲートウェイパスワードを上書き
- `--setup-code-only`: セットアップコードのみを表示
- `--no-ascii`: ASCII QRレンダリングをスキップ
- `--json`: JSON出力（`setupCode`、`gatewayUrl`、`auth`、`urlSource`）

## 注意事項

- `--token` と `--password` は相互排他的です。
- セットアップコード自体には、共有Gateway ゲートウェイトークン/パスワードではなく、不透明な短期間有効の `bootstrapToken` が含まれるようになりました。
- `--remote` を使用する場合、実質的にアクティブなリモート認証情報がSecretRefとして設定されており、`--token` または `--password` を渡さない場合、コマンドはアクティブなGateway ゲートウェイスナップショットからそれらを解決します。Gateway ゲートウェイが利用できない場合、コマンドは即座に失敗します。
- `--remote` なしの場合、CLI認証オーバーライドが渡されていないとき、ローカルGateway ゲートウェイ認証のSecretRefが解決されます:
  - `gateway.auth.token` はトークン認証が有効な場合に解決されます（明示的な `gateway.auth.mode="token"` または、パスワードソースが優先されない推論モード）。
  - `gateway.auth.password` はパスワード認証が有効な場合に解決されます（明示的な `gateway.auth.mode="password"` または、auth/envからの優先トークンがない推論モード）。
- `gateway.auth.token` と `gateway.auth.password` の両方が設定されており（SecretRefを含む）、`gateway.auth.mode` が未設定の場合、モードが明示的に設定されるまでセットアップコードの解決は失敗します。
- Gateway ゲートウェイのバージョン差異に関する注意: このコマンドパスには `secrets.resolve` をサポートするGateway ゲートウェイが必要です。古いGateway ゲートウェイではunknown-methodエラーが返されます。
- スキャン後、以下でデバイスペアリングを承認してください:
  - `openclaw devices list`
  - `openclaw devices approve <requestId>`
