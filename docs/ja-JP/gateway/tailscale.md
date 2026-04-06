---
read_when:
    - Gateway ゲートウェイ Control UI を localhost 外に公開する場合
    - tailnet またはパブリックダッシュボードアクセスを自動化する場合
summary: Gateway ゲートウェイダッシュボード向けの統合 Tailscale Serve/Funnel
title: Tailscale
x-i18n:
    generated_at: "2026-04-02T07:43:26Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 30c91f2ca5ab6aef19fbb166c170673020ce1c4e308a6abd6724774a5e595e9c
    source_path: gateway/tailscale.md
    workflow: 15
---

# Tailscale（Gateway ゲートウェイダッシュボード）

OpenClaw は Gateway ゲートウェイダッシュボードと WebSocket ポート向けに Tailscale **Serve**（tailnet）または **Funnel**（パブリック）を自動設定できます。これにより Gateway ゲートウェイは loopback にバインドされたまま、Tailscale が HTTPS、ルーティング、および（Serve の場合）ID ヘッダーを提供します。

## モード

- `serve`: `tailscale serve` による tailnet 限定の Serve。Gateway ゲートウェイは `127.0.0.1` のままです。
- `funnel`: `tailscale funnel` によるパブリック HTTPS。OpenClaw は共有パスワードを必要とします。
- `off`: デフォルト（Tailscale 自動化なし）。

## 認証

`gateway.auth.mode` を設定してハンドシェイクを制御します：

- `token`（`OPENCLAW_GATEWAY_TOKEN` が設定されている場合のデフォルト）
- `password`（`OPENCLAW_GATEWAY_PASSWORD` または設定による共有シークレット）

`tailscale.mode = "serve"` かつ `gateway.auth.allowTailscale` が `true` の場合、Control UI/WebSocket の認証はトークン/パスワードを提供せずに Tailscale の ID ヘッダー（`tailscale-user-login`）を使用できます。OpenClaw はローカルの Tailscale デーモン（`tailscale whois`）を通じて `x-forwarded-for` アドレスを解決し、ヘッダーと一致するか確認してから受け入れることで ID を検証します。OpenClaw はリクエストが loopback から Tailscale の `x-forwarded-for`、`x-forwarded-proto`、`x-forwarded-host` ヘッダー付きで到着した場合にのみ Serve として扱います。
HTTP API エンドポイント（例：`/v1/*`、`/tools/invoke`、`/api/channels/*`）にはトークン/パスワード認証が引き続き必要です。
このトークンレスフローは Gateway ゲートウェイホストが信頼されていることを前提としています。信頼されていないローカルコードが同じホスト上で実行される可能性がある場合は、`gateway.auth.allowTailscale` を無効にし、代わりにトークン/パスワード認証を要求してください。
明示的な資格情報を要求するには、`gateway.auth.allowTailscale: false` を設定するか、`gateway.auth.mode: "password"` を強制してください。

## 設定例

### tailnet 限定（Serve）

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

アクセス先: `https://<magicdns>/`（または設定した `gateway.controlUi.basePath`）

### tailnet 限定（Tailnet IP にバインド）

Gateway ゲートウェイを Tailnet IP で直接リッスンさせたい場合に使用します（Serve/Funnel なし）。

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

別の Tailnet デバイスから接続：

- Control UI: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

注意: このモードでは loopback（`http://127.0.0.1:18789`）は動作**しません**。

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

パスワードをディスクにコミットするよりも `OPENCLAW_GATEWAY_PASSWORD` の使用を推奨します。

## CLI の例

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## 注意事項

- Tailscale Serve/Funnel には `tailscale` CLI がインストールされログイン済みであることが必要です。
- `tailscale.mode: "funnel"` はパブリック公開を防ぐため、認証モードが `password` でない場合は起動を拒否します。
- シャットダウン時に OpenClaw が `tailscale serve` または `tailscale funnel` の設定を元に戻すようにするには `gateway.tailscale.resetOnExit` を設定してください。
- `gateway.bind: "tailnet"` は直接的な Tailnet バインドです（HTTPS なし、Serve/Funnel なし）。
- `gateway.bind: "auto"` は loopback を優先します。Tailnet 限定にしたい場合は `tailnet` を使用してください。
- Serve/Funnel は **Gateway ゲートウェイ Control UI + WS** のみを公開します。ノードは同じ Gateway ゲートウェイ WS エンドポイント経由で接続するため、Serve はノードアクセスにも使用できます。

## ブラウザ制御（リモート Gateway ゲートウェイ + ローカルブラウザ）

Gateway ゲートウェイを別のマシンで実行し、別のマシンでブラウザを操作したい場合は、ブラウザマシン上で**ノードホスト**を実行し、両方を同じ tailnet に接続してください。Gateway ゲートウェイがブラウザ操作をノードにプロキシするため、別途 control server や Serve URL は不要です。

ブラウザ制御に Funnel を使用するのは避けてください。ノードペアリングはオペレーターアクセスと同様に扱ってください。

## Tailscale の前提条件と制限

- Serve には tailnet で HTTPS が有効になっている必要があります。有効でない場合は CLI がプロンプトを表示します。
- Serve は Tailscale の ID ヘッダーを挿入しますが、Funnel は挿入しません。
- Funnel には Tailscale v1.38.3 以降、MagicDNS、HTTPS の有効化、および funnel ノード属性が必要です。
- Funnel は TLS 経由でポート `443`、`8443`、`10000` のみをサポートします。
- macOS での Funnel にはオープンソース版の Tailscale アプリが必要です。

## 詳細情報

- Tailscale Serve の概要: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve` コマンド: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tailscale Funnel の概要: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel` コマンド: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
