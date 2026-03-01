---
summary: "Gateway の Web サーフェス: コントロール UI、バインドモード、セキュリティ"
read_when:
  - Tailscale 経由で Gateway にアクセスしたい場合
  - ブラウザのコントロール UI と設定編集が必要な場合
title: "Web"
---

# Web（Gateway）

Gateway は、Gateway WebSocket と同じポートから小さな**ブラウザ用コントロール UI**（Vite + Lit）を配信します。

- デフォルト: `http://<host>:18789/`
- オプションのプレフィックス: `gateway.controlUi.basePath` を設定（例: `/openclaw`）

機能の詳細は [コントロール UI](/web/control-ui) にあります。
このページでは、バインドモード、セキュリティ、Web 向けサーフェスについて説明します。

## Webhook

`hooks.enabled=true` の場合、Gateway は同じ HTTP サーバー上に小さな Webhook エンドポイントも公開します。
認証とペイロードについては [Gateway 設定](/gateway/configuration) → `hooks` を参照してください。

## 設定（デフォルト有効）

コントロール UI はアセットが存在する場合（`dist/control-ui`）、**デフォルトで有効**です。
設定で制御できます。

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath はオプション
  },
}
```

## Tailscale アクセス

### 統合 Serve（推奨）

Gateway をループバックに保ち、Tailscale Serve がプロキシするようにします。

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

その後、Gateway を起動します。

```bash
openclaw gateway
```

開く先:

- `https://<magicdns>/`（または設定した `gateway.controlUi.basePath`）

### Tailnet バインド + トークン

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

その後、Gateway を起動します（ループバック以外のバインドにはトークンが必要）。

```bash
openclaw gateway
```

開く先:

- `http://<tailscale-ip>:18789/`（または設定した `gateway.controlUi.basePath`）

### 公衆インターネット（Funnel）

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // または OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## セキュリティに関する注意事項

- Gateway 認証はデフォルトで必須です（トークン/パスワードまたは Tailscale アイデンティティヘッダー）。
- ループバック以外のバインドでも、共有トークン/パスワードが**必要**です（`gateway.auth` または環境変数）。
- ウィザードはデフォルトで Gateway トークンを生成します（ループバックでも）。
- UI は `connect.params.auth.token` または `connect.params.auth.password` を送信します。
- ループバック以外のコントロール UI デプロイでは、`gateway.controlUi.allowedOrigins` を明示的に設定してください（完全なオリジン）。設定がない場合、デフォルトで Gateway の起動が拒否されます。
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true` は Host ヘッダーオリジンフォールバックモードを有効にしますが、危険なセキュリティの低下を招きます。
- Serve を使用する場合、`gateway.auth.allowTailscale` が `true` のとき、Tailscale のアイデンティティヘッダーでコントロール UI/WebSocket の認証を満たすことができます（トークン/パスワード不要）。HTTP API エンドポイントは引き続きトークン/パスワードが必要です。明示的な認証情報を要求する場合は `gateway.auth.allowTailscale: false` を設定してください。[Tailscale](/gateway/tailscale) と [セキュリティ](/gateway/security) を参照してください。このトークンなしのフローは、Gateway ホストが信頼されていることを前提としています。
- `gateway.tailscale.mode: "funnel"` には `gateway.auth.mode: "password"`（共有パスワード）が必要です。

## UI のビルド

Gateway は `dist/control-ui` から静的ファイルを配信します。以下でビルドします。

```bash
pnpm ui:build # 初回実行時に UI の依存関係を自動インストール
```
