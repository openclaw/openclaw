---
summary: "Gatewayダッシュボード向けの統合Tailscale Serve/Funnel"
read_when:
  - Exposing the Gateway Control UI outside localhost
  - Automating tailnet or public dashboard access
title: "Tailscale"
---

# Tailscale（Gatewayダッシュボード）

OpenClawはGatewayダッシュボードとWebSocketポート向けにTailscale **Serve**（Tailnet）または**Funnel**（パブリック）を自動設定できます。これによりGatewayをループバックにバインドしたまま、TailscaleがHTTPS、ルーティング、および（Serveの場合）アイデンティティヘッダーを提供します。

## モード

- `serve`：`tailscale serve`経由のTailnet限定Serve。Gatewayは`127.0.0.1`に留まります。
- `funnel`：`tailscale funnel`経由のパブリックHTTPS。OpenClawは共有パスワードを要求します。
- `off`：デフォルト（Tailscaleオートメーションなし）。

## 認証

`gateway.auth.mode`を設定してハンドシェイクを制御します：

- `token`（`OPENCLAW_GATEWAY_TOKEN`が設定されている場合のデフォルト）
- `password`（`OPENCLAW_GATEWAY_PASSWORD`または設定経由の共有シークレット）

`tailscale.mode = "serve"`かつ`gateway.auth.allowTailscale`が`true`の場合、
Control UI/WebSocket認証はトークン/パスワードを提供せずにTailscaleアイデンティティヘッダー（`tailscale-user-login`）を使用できます。OpenClawはローカルTailscaleデーモン（`tailscale whois`）経由で`x-forwarded-for`アドレスを解決し、ヘッダーと照合してからアイデンティティを検証します。
OpenClawはTailscaleの`x-forwarded-for`、`x-forwarded-proto`、`x-forwarded-host`ヘッダー付きでループバックから到着したリクエストのみをServeとして扱います。
HTTP APIエンドポイント（例：`/v1/*`、`/tools/invoke`、`/api/channels/*`）にはトークン/パスワード認証が必要です。
このトークンレスフローはGatewayホストが信頼されていることを前提としています。信頼されていないローカルコードが同じホスト上で実行される可能性がある場合は、`gateway.auth.allowTailscale`を無効にしてトークン/パスワード認証を要求してください。
明示的な認証情報を要求するには、`gateway.auth.allowTailscale: false`を設定するか、`gateway.auth.mode: "password"`を強制してください。

## 設定例

### Tailnet限定（Serve）

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

開く：`https://<magicdns>/`（または設定された`gateway.controlUi.basePath`）

### Tailnet限定（Tailnet IPにバインド）

GatewayをTailnet IP上で直接リッスンさせたい場合に使用します（Serve/Funnelなし）。

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

別のTailnetデバイスから接続：

- Control UI：`http://<tailscale-ip>:18789/`
- WebSocket：`ws://<tailscale-ip>:18789`

注意：このモードではループバック（`http://127.0.0.1:18789`）は動作**しません**。

### パブリックインターネット（Funnel + 共有パスワード）

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

ディスクにパスワードをコミットするよりも`OPENCLAW_GATEWAY_PASSWORD`を推奨します。

## CLIの例

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## 注意事項

- Tailscale Serve/Funnelには`tailscale` CLIがインストールされログインしている必要があります。
- `tailscale.mode: "funnel"`はパブリック公開を避けるため、認証モードが`password`でない限り起動を拒否します。
- Gatewayシャットダウン時にOpenClawが`tailscale serve`または`tailscale funnel`設定を元に戻す場合は`gateway.tailscale.resetOnExit`を設定してください。
- `gateway.bind: "tailnet"`は直接Tailnetバインドです（HTTPS、Serve/Funnelなし）。
- `gateway.bind: "auto"`はループバックを優先します。Tailnetのみが必要な場合は`tailnet`を使用してください。
- Serve/Funnelは**Gateway Control UI + WS**のみを公開します。ノードは同じGateway WSエンドポイント経由で接続するため、Serveはノードアクセスにも機能します。

## ブラウザコントロール（リモートGateway + ローカルブラウザ）

あるマシンでGatewayを実行しているが別のマシンでブラウザを操作したい場合、
ブラウザマシンで**ノードホスト**を実行し、両方を同じTailnetに置いてください。
Gatewayがブラウザアクションをノードにプロキシします。別のコントロールサーバーやServe URLは不要です。

ブラウザコントロールにFunnelを使用しないでください。ノードペアリングはオペレーターアクセスと同様に扱ってください。

## Tailscaleの前提条件 + 制限

- ServeにはTailnetでHTTPSが有効になっている必要があります。CLIが不足している場合にプロンプトします。
- ServeはTailscaleアイデンティティヘッダーを挿入します。Funnelはしません。
- FunnelにはTailscale v1.38.3+、MagicDNS、HTTPS有効化、Funnelノード属性が必要です。
- Funnelはポート`443`、`8443`、`10000`のみをTLS経由でサポートします。
- macOSでのFunnelにはオープンソースのTailscaleアプリバリアントが必要です。

## 詳細情報

- Tailscale Serve概要：[https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve`コマンド：[https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tailscale Funnel概要：[https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel`コマンド：[https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
