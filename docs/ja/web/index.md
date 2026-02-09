---
summary: "Gateway（ゲートウェイ）の Web サーフェス：コントロール UI、バインドモード、セキュリティ"
read_when:
  - Tailscale 経由で Gateway にアクセスしたい場合
  - ブラウザーのコントロール UI と設定編集を利用したい場合
title: "Web"
---

# Web（Gateway）

Gateway は、Gateway WebSocket と同じポートから小規模な **ブラウザー コントロール UI**（Vite + Lit）を提供します。

- デフォルト：`http://<host>:18789/`
- オプションのプレフィックス：`gateway.controlUi.basePath` を設定（例：`/openclaw`）

32. 機能は [Control UI](/web/control-ui) にあります。
    このページでは、バインドモード、セキュリティ、ウェブ面に焦点を当てています。

## Webhooks

`hooks.enabled=true` の場合、Gateway は同じ HTTP サーバー上で小規模な Webhook エンドポイントも公開します。
認証およびペイロードについては、[Gateway configuration](/gateway/configuration) → `hooks` を参照してください。
認証+ペイロードについては、[ゲートウェイ設定](/gateway/configuration) → `フック` を参照してください。

## Config（デフォルト有効）

アセットが存在する場合、コントロール UI は **デフォルトで有効** です（`dist/control-ui`）。
設定で制御できます。
以下の設定で制御できます。

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## Tailscale アクセス

### Integrated Serve（推奨）

Gateway を loopback に維持し、Tailscale Serve にプロキシさせます。

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

次に Gateway を起動します。

```bash
openclaw gateway
```

開く：

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

次に Gateway を起動します（loopback 以外のバインドにはトークンが必要です）。

```bash
openclaw gateway
```

開く：

- `http://<tailscale-ip>:18789/`（または設定した `gateway.controlUi.basePath`）

### 公開インターネット（Funnel）

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## セキュリティ注記

- Gateway の認証はデフォルトで必須です（トークン／パスワード、または Tailscale のアイデンティティヘッダー）。
- loopback 以外のバインドでは、共有トークン／パスワードが **必須** です（`gateway.auth` または env）。
- ウィザードは、デフォルトで Gateway トークンを生成します（loopback の場合でも）。
- UI は `connect.params.auth.token` または `connect.params.auth.password` を送信します。
- コントロール UI はアンチクリックジャッキングのヘッダーを送信し、`gateway.controlUi.allowedOrigins` が設定されていない限り、同一オリジンのブラウザー WebSocket 接続のみを受け付けます。
- Serve を使用する場合、`gateway.auth.allowTailscale` が `true` のとき、Tailscale のアイデンティティヘッダーで認証を満たせます（トークン／パスワード不要）。明示的な資格情報を必須にするには `gateway.auth.allowTailscale: false` を設定してください。詳細は [Tailscale](/gateway/tailscale) および [Security](/gateway/security) を参照してください。 明示的な資格情報を必要とするには、
  `gateway.auth.allowTailscale: false` を設定してください。
  [Tailscale](/gateway/tailscale) と [Security](/gateway/security) を参照してください。
- `gateway.tailscale.mode: "funnel"` には `gateway.auth.mode: "password"`（共有パスワード）が必要です。

## UI のビルド

Gateway は `dist/control-ui` から静的ファイルを提供します。次のコマンドでビルドしてください。 以下でビルドします。

```bash
pnpm ui:build # auto-installs UI deps on first run
```
