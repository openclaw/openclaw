---
read_when:
    - IDを認識するプロキシの背後でOpenClawを実行する場合
    - OpenClawの前段にPomerium、Caddy、またはnginx + OAuthをセットアップする場合
    - リバースプロキシ構成でWebSocket 1008 unauthorizedエラーを修正する場合
    - HSTSやその他のHTTPハードニングヘッダーをどこに設定すべきか判断する場合
summary: Gateway ゲートウェイの認証を信頼されたリバースプロキシ（Pomerium、Caddy、nginx + OAuth）に委任する
title: 信頼されたプロキシ認証
x-i18n:
    generated_at: "2026-04-02T07:44:03Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: d1b8a7c7e6ee5081603cb3f0f9e63045146a02833ecc7a31b92c8cba381322b5
    source_path: gateway/trusted-proxy-auth.md
    workflow: 15
---

# 信頼されたプロキシ認証

> ⚠️ **セキュリティに関わる機能です。** このモードは認証を完全にリバースプロキシに委任します。設定ミスがあると、Gateway ゲートウェイが不正アクセスにさらされる可能性があります。有効にする前にこのページをよくお読みください。

## 使用するタイミング

以下の場合に `trusted-proxy` 認証モードを使用してください：

- **IDを認識するプロキシ**（Pomerium、Caddy + OAuth、nginx + oauth2-proxy、Traefik + forward auth）の背後でOpenClawを実行している場合
- プロキシがすべての認証を処理し、ヘッダー経由でユーザーIDを渡す場合
- KubernetesまたはコンテナGateway ゲートウェイ環境で、プロキシがGateway ゲートウェイへの唯一の経路である場合
- ブラウザがWSペイロードでトークンを渡せないため、WebSocket `1008 unauthorized` エラーが発生している場合

## 使用すべきでないタイミング

- プロキシがユーザーを認証しない場合（単なるTLSターミネーターやロードバランサーの場合）
- プロキシをバイパスしてGateway ゲートウェイに到達する経路がある場合（ファイアウォールの穴、内部ネットワークアクセスなど）
- プロキシが転送ヘッダーを正しくストリップ/上書きしているか不明な場合
- 個人的なシングルユーザーアクセスのみが必要な場合（よりシンプルな構成として Tailscale Serve + local loopback を検討してください）

## 仕組み

1. リバースプロキシがユーザーを認証します（OAuth、OIDC、SAMLなど）
2. プロキシが認証済みユーザーIDを含むヘッダーを追加します（例：`x-forwarded-user: nick@example.com`）
3. OpenClawがリクエストが**信頼されたプロキシIP**（`gateway.trustedProxies` で設定）から来たことを確認します
4. OpenClawが設定されたヘッダーからユーザーIDを抽出します
5. すべてのチェックが通れば、リクエストが認可されます

## コントロールUIのペアリング動作

`gateway.auth.mode = "trusted-proxy"` が有効で、リクエストが信頼されたプロキシのチェックを通過した場合、コントロールUIのWebSocketセッションはデバイスペアリングIDなしで接続できます。

影響：

- このモードでは、ペアリングはコントロールUIアクセスの主要なゲートではなくなります。
- リバースプロキシの認証ポリシーと `allowUsers` が実質的なアクセス制御になります。
- Gateway ゲートウェイの受信トラフィックは信頼されたプロキシIPのみに制限してください（`gateway.trustedProxies` + ファイアウォール）。

## 設定

```json5
{
  gateway: {
    // 同一ホストのプロキシ構成にはloopbackを使用、リモートプロキシホストにはlan/customを使用
    bind: "loopback",

    // 重要: プロキシのIPのみをここに追加してください
    trustedProxies: ["10.0.0.1", "172.17.0.1"],

    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        // 認証済みユーザーIDを含むヘッダー（必須）
        userHeader: "x-forwarded-user",

        // オプション: 存在しなければならないヘッダー（プロキシ検証用）
        requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],

        // オプション: 特定のユーザーに制限（空 = 全員許可）
        allowUsers: ["nick@example.com", "admin@company.org"],
      },
    },
  },
}
```

`gateway.bind` が `loopback` の場合、`gateway.trustedProxies` にループバックプロキシアドレス（`127.0.0.1`、`::1`、または同等のループバックCIDR）を含めてください。

### 設定リファレンス

| フィールド                                       | 必須 | 説明                                                                 |
| ------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| `gateway.trustedProxies`                    | はい      | 信頼するプロキシIPアドレスの配列。他のIPからのリクエストは拒否されます。 |
| `gateway.auth.mode`                         | はい      | `"trusted-proxy"` に設定する必要があります                                                   |
| `gateway.auth.trustedProxy.userHeader`      | はい      | 認証済みユーザーIDを含むヘッダー名                      |
| `gateway.auth.trustedProxy.requiredHeaders` | いいえ       | リクエストが信頼されるために存在しなければならない追加ヘッダー       |
| `gateway.auth.trustedProxy.allowUsers`      | いいえ       | ユーザーIDの許可リスト。空の場合、認証済みの全ユーザーを許可します。    |

## TLSターミネーションとHSTS

TLSターミネーションポイントは1つにし、そこでHSTSを適用してください。

### 推奨パターン：プロキシでのTLSターミネーション

リバースプロキシが `https://control.example.com` のHTTPSを処理する場合、そのドメインに対してプロキシで `Strict-Transport-Security` を設定してください。

- インターネットに公開するデプロイメントに適しています。
- 証明書とHTTPハードニングポリシーを1か所にまとめられます。
- OpenClawはプロキシの背後でlocal loopback HTTPのままで構いません。

ヘッダー値の例：

```text
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

### Gateway ゲートウェイでのTLSターミネーション

OpenClaw自体がHTTPSを直接提供する場合（TLSターミネーションプロキシなし）、以下を設定してください：

```json5
{
  gateway: {
    tls: { enabled: true },
    http: {
      securityHeaders: {
        strictTransportSecurity: "max-age=31536000; includeSubDomains",
      },
    },
  },
}
```

`strictTransportSecurity` はヘッダー値の文字列、または明示的に無効にする場合は `false` を受け付けます。

### ロールアウトガイダンス

- トラフィックを検証する間は、まず短いmax-age（例：`max-age=300`）から始めてください。
- 十分な確信が得られてから、長期間の値（例：`max-age=31536000`）に増やしてください。
- `includeSubDomains` はすべてのサブドメインがHTTPS対応の場合にのみ追加してください。
- preloadはドメインセット全体でpreload要件を意図的に満たしている場合にのみ使用してください。
- local loopbackのみのローカル開発ではHSTSの恩恵はありません。

## プロキシセットアップ例

### Pomerium

Pomeriumは `x-pomerium-claim-email`（またはその他のクレームヘッダー）でIDを渡し、`x-pomerium-jwt-assertion` にJWTを含めます。

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["10.0.0.1"], // PomeriumのIP
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-pomerium-claim-email",
        requiredHeaders: ["x-pomerium-jwt-assertion"],
      },
    },
  },
}
```

Pomerium設定スニペット：

```yaml
routes:
  - from: https://openclaw.example.com
    to: http://openclaw-gateway:18789
    policy:
      - allow:
          or:
            - email:
                is: nick@example.com
    pass_identity_headers: true
```

### Caddy + OAuth

`caddy-security` プラグインを使用したCaddyは、ユーザーを認証してIDヘッダーを渡すことができます。

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["127.0.0.1"], // CaddyのIP（同一ホストの場合）
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
      },
    },
  },
}
```

Caddyfileスニペット：

```
openclaw.example.com {
    authenticate with oauth2_provider
    authorize with policy1

    reverse_proxy openclaw:18789 {
        header_up X-Forwarded-User {http.auth.user.email}
    }
}
```

### nginx + oauth2-proxy

oauth2-proxyはユーザーを認証し、`x-auth-request-email` でIDを渡します。

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["10.0.0.1"], // nginx/oauth2-proxyのIP
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-auth-request-email",
      },
    },
  },
}
```

nginx設定スニペット：

```nginx
location / {
    auth_request /oauth2/auth;
    auth_request_set $user $upstream_http_x_auth_request_email;

    proxy_pass http://openclaw:18789;
    proxy_set_header X-Auth-Request-Email $user;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

### Traefik + Forward Auth

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["172.17.0.1"], // TraefikコンテナのIP
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
      },
    },
  },
}
```

## 混合トークン設定

OpenClawは、`gateway.auth.token`（または `OPENCLAW_GATEWAY_TOKEN`）と `trusted-proxy` モードの両方が同時にアクティブになっている曖昧な設定を拒否します。混合トークン設定は、ループバックリクエストが誤った認証パスでサイレントに認証される原因になります。

起動時に `mixed_trusted_proxy_token` エラーが表示された場合：

- trusted-proxyモード使用時は共有トークンを削除してください、または
- トークンベースの認証を意図している場合は `gateway.auth.mode` を `"token"` に切り替えてください。

ループバックの信頼されたプロキシ認証もフェイルクローズです。同一ホストの呼び出し元は、サイレントに認証されるのではなく、信頼されたプロキシ経由で設定されたIDヘッダーを提供する必要があります。

## セキュリティチェックリスト

信頼されたプロキシ認証を有効にする前に、以下を確認してください：

- [ ] **プロキシが唯一の経路であること**: Gateway ゲートウェイのポートがプロキシ以外からファイアウォールで遮断されていること
- [ ] **trustedProxiesが最小限であること**: 実際のプロキシIPのみで、サブネット全体ではないこと
- [ ] **プロキシがヘッダーをストリップすること**: プロキシがクライアントからの `x-forwarded-*` ヘッダーを追記ではなく上書きすること
- [ ] **TLSターミネーション**: プロキシがTLSを処理し、ユーザーがHTTPS経由で接続すること
- [ ] **allowUsersが設定されていること**（推奨）: 認証済みの全員を許可するのではなく、既知のユーザーに制限すること
- [ ] **混合トークン設定がないこと**: `gateway.auth.token` と `gateway.auth.mode: "trusted-proxy"` を両方設定しないこと

## セキュリティ監査

`openclaw security audit` は信頼されたプロキシ認証を **critical** の重大度で報告します。これは意図的なもので、セキュリティをプロキシ構成に委任していることを忘れないためのリマインダーです。

監査では以下をチェックします：

- `trustedProxies` 設定が欠けていないか
- `userHeader` 設定が欠けていないか
- `allowUsers` が空でないか（認証済みの全ユーザーを許可している状態）

## トラブルシューティング

### "trusted_proxy_untrusted_source"

リクエストが `gateway.trustedProxies` 内のIPから来ていません。以下を確認してください：

- プロキシのIPは正しいですか？（DockerコンテナのIPは変わることがあります）
- プロキシの前にロードバランサーがありますか？
- `docker inspect` や `kubectl get pods -o wide` で実際のIPを確認してください

### "trusted_proxy_user_missing"

ユーザーヘッダーが空または欠落しています。以下を確認してください：

- プロキシがIDヘッダーを渡すように設定されていますか？
- ヘッダー名は正しいですか？（大文字小文字を区別しませんが、スペルは重要です）
- ユーザーはプロキシで実際に認証されていますか？

### "trusted*proxy_missing_header*\*"

必須ヘッダーが存在しませんでした。以下を確認してください：

- それらの特定のヘッダーに関するプロキシの設定
- チェーンのどこかでヘッダーがストリップされていないか

### "trusted_proxy_user_not_allowed"

ユーザーは認証されていますが、`allowUsers` に含まれていません。ユーザーを追加するか、許可リストを削除してください。

### WebSocketがまだ失敗する場合

プロキシが以下を満たしていることを確認してください：

- WebSocketアップグレードをサポートしていること（`Upgrade: websocket`、`Connection: upgrade`）
- WebSocketアップグレードリクエスト時にもIDヘッダーを渡していること（HTTPだけでなく）
- WebSocket接続用に別の認証パスがないこと

## トークン認証からの移行

トークン認証から信頼されたプロキシに移行する場合：

1. ユーザーを認証してヘッダーを渡すようにプロキシを設定する
2. プロキシのセットアップを独立してテストする（ヘッダー付きcurl）
3. OpenClawの設定を信頼されたプロキシ認証に更新する
4. Gateway ゲートウェイを再起動する
5. コントロールUIからのWebSocket接続をテストする
6. `openclaw security audit` を実行して結果を確認する

## 関連ページ

- [セキュリティ](/gateway/security) — セキュリティの完全ガイド
- [設定](/gateway/configuration) — 設定リファレンス
- [リモートアクセス](/gateway/remote) — その他のリモートアクセスパターン
- [Tailscale](/gateway/tailscale) — tailnetのみのアクセスに適したシンプルな代替手段
