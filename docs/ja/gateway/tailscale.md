---
summary: "Gateway ダッシュボード向けに統合された Tailscale Serve/Funnel"
read_when:
  - localhost 外で Gateway コントロール UI を公開する場合
  - tailnet または公開ダッシュボードのアクセスを自動化する場合
title: "Tailscale"
---

# Tailscale（Gateway ダッシュボード）

OpenClaw は、Gateway ダッシュボードおよび WebSocket ポート向けに
Tailscale **Serve**（tailnet）または **Funnel**（公開）を自動設定できます。
これにより、Gateway は local loopback にバインドされたまま、
Tailscale が HTTPS、ルーティング、（Serve の場合は）ID ヘッダーを提供します。 これにより、ゲートウェイはループバックにバインドされます。一方、
TailscaleはHTTPS、ルーティング、および(サーブ用)IDヘッダを提供します。

## モード

- `serve`: `tailscale serve` による tailnet 専用 Serve。ゲートウェイは `127.0.0.1` 上に留まります。 ゲートウェイは `127.0.0.1` のままです。
- `funnel`: `tailscale funnel` による公開 HTTPS。OpenClaw では共有パスワードが必要です。 OpenClawは共有パスワードが必要です。
- `off`: デフォルト（Tailscale 自動化なし）。

## 認証

ハンドシェイクを制御するには `gateway.auth.mode` を設定します。

- `token`（`OPENCLAW_GATEWAY_TOKEN` が設定されている場合のデフォルト）
- `password`（`OPENCLAW_GATEWAY_PASSWORD` または設定による共有シークレット）

`tailscale.mode = "serve"` が有効で、かつ `gateway.auth.allowTailscale` が `true` の場合、
有効な Serve プロキシリクエストは、トークンやパスワードを指定せずに
Tailscale の ID ヘッダー（`tailscale-user-login`）を用いて認証できます。
OpenClaw は、ローカルの Tailscale デーモン（`tailscale whois`）経由で
`x-forwarded-for` アドレスを解決し、ヘッダーと一致することを確認してから受け入れます。
OpenClaw は、リクエストが loopback から到達し、
Tailscale の `x-forwarded-for`、`x-forwarded-proto`、`x-forwarded-host`
ヘッダーを含む場合にのみ、Serve として扱います。
明示的な資格情報を必須にするには `gateway.auth.allowTailscale: false` を設定するか、
`gateway.auth.mode: "password"` を強制してください。 OpenClaw は、ローカルの Tailscale
デーモン(`tailscale whois`)を介して `x-forwarded-for` アドレスを解決し、それを受け入れる前にヘッダにマッチさせることで、
身元を検証します。
OpenClawは、ループバックから
Tailscaleの`x-forwarded-for`、`x-forward-proto`、および`x-forwarded-host`
ヘッダでリクエストが到着したときにのみServeとして扱います。
明示的な資格情報を必要とするには、`gateway.auth.allowTailscale: false` または
で `gateway.auth.mode: "password"` を強制します。

## 設定例

### Tailnet 専用（Serve）

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

開く: `https://<magicdns>/`（または設定した `gateway.controlUi.basePath`）

### Tailnet 専用（Tailnet IP にバインド）

Gateway を Tailnet IP に直接リッスンさせたい場合（Serve/Funnel なし）に使用します。

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

別の Tailnet デバイスから接続します。

- コントロール UI: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

注記: このモードでは loopback（`http://127.0.0.1:18789`）は **使用できません**。

### 公開インターネット（Funnel + 共有パスワード）

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

パスワードをディスクにコミットするよりも `OPENCLAW_GATEWAY_PASSWORD` を推奨します。

## CLI の例

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## 注記

- Tailscale Serve/Funnel には、`tailscale` CLI がインストールされ、ログイン済みである必要があります。
- `tailscale.mode: "funnel"` は、公開露出を避けるため、認証モードが `password` でない限り起動を拒否します。
- シャットダウン時に OpenClaw が `tailscale serve` または
  `tailscale funnel` の設定を元に戻すようにするには `gateway.tailscale.resetOnExit` を設定します。
- `gateway.bind: "tailnet"` は Tailnet への直接バインドです（HTTPS なし、Serve/Funnel なし）。
- `gateway.bind: "auto"` は loopback を優先します。Tailnet 専用にしたい場合は `tailnet` を使用してください。
- サーブ/ファンネルは**ゲートウェイコントロール UI + WS** のみを公開します。 Serve/Funnel が公開するのは **Gateway コントロール UI + WS** のみです。
  ノードは同じ Gateway WS エンドポイント経由で接続するため、
  ノードアクセスにも Serve を利用できます。

## ブラウザー制御（リモート Gateway + ローカルブラウザー）

Gateway を 1 台のマシンで実行し、別のマシンでブラウザーを操作したい場合は、
ブラウザー側のマシンで **node host** を実行し、両方を同一の tailnet に維持します。
Gateway はブラウザー操作をノードへプロキシします。
個別のコントロールサーバーや Serve URL は不要です。
ゲートウェイは、ノードに対してプロキシブラウザのアクションを実行します。個別のコントロールサーバーや Serve URL は必要ありません。

ブラウザー制御には Funnel を避け、ノードのペアリングはオペレーターアクセスとして扱ってください。

## Tailscale の前提条件と制限

- Serve には tailnet で HTTPS が有効化されている必要があります。未設定の場合、CLI が案内します。
- Serve は Tailscale の ID ヘッダーを注入しますが、Funnel は注入しません。
- Funnel には Tailscale v1.38.3 以降、MagicDNS、HTTPS 有効化、funnel ノード属性が必要です。
- Funnel は TLS 上でポート `443`、`8443`、`10000` のみをサポートします。
- macOS での Funnel は、オープンソース版の Tailscale アプリが必要です。

## 詳細情報

- Tailscale Serve の概要: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve` コマンド: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tailscale Funnel の概要: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel` コマンド: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
