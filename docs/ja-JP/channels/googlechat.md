---
summary: "Google Chatアプリのサポート状況、機能、設定"
read_when:
  - Google Chatチャンネル機能を作業するとき
title: "Google Chat"
---

# Google Chat（Chat API）

ステータス: Google Chat APIウェブフック（HTTPのみ）によるDM + スペース対応。

## クイックセットアップ（初心者向け）

1. Google Cloudプロジェクトを作成し、**Google Chat API**を有効にします。
   - [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)にアクセス
   - まだ有効でない場合はAPIを有効にします。
2. **サービスアカウント**を作成します:
   - **Create Credentials** > **Service Account**を押します。
   - 任意の名前を付けます（例: `openclaw-chat`）。
   - 権限は空のまま（**Continue**を押します）。
   - プリンシパルへのアクセスは空のまま（**Done**を押します）。
3. **JSONキー**を作成してダウンロードします:
   - サービスアカウント一覧で、作成したものをクリックします。
   - **Keys**タブに移動します。
   - **Add Key** > **Create new key**をクリックします。
   - **JSON**を選択して**Create**を押します。
4. ダウンロードしたJSONファイルをGatewayホストに保存します（例: `~/.openclaw/googlechat-service-account.json`）。
5. [Google Cloud Console Chat設定](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat)でGoogle Chatアプリを作成します:
   - **Application info**を入力:
     - **App name**: （例: `OpenClaw`）
     - **Avatar URL**: （例: `https://openclaw.ai/logo.png`）
     - **Description**: （例: `Personal AI Assistant`）
   - **Interactive features**を有効にします。
   - **Functionality**で、**Join spaces and group conversations**にチェックを入れます。
   - **Connection settings**で、**HTTP endpoint URL**を選択します。
   - **Triggers**で、**Use a common HTTP endpoint URL for all triggers**を選択し、GatewayのパブリックURLに`/googlechat`を追加して設定します。
     - _ヒント: `openclaw status`を実行してGatewayのパブリックURLを確認できます。_
   - **Visibility**で、**Make this Chat app available to specific people and groups in &lt;Your Domain&gt;**にチェックを入れます。
   - メールアドレスを入力します（例: `user@example.com`）。
   - 下部の**Save**をクリックします。
6. **アプリステータスを有効にします**:
   - 保存後、**ページを更新**します。
   - **App status**セクションを探します（通常、保存後の上部または下部）。
   - ステータスを**Live - available to users**に変更します。
   - 再度**Save**をクリックします。
7. サービスアカウントパス + ウェブフックオーディエンスでOpenClawを設定します:
   - 環境変数: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - または設定: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`
8. ウェブフックオーディエンスタイプ + 値を設定します（Chatアプリの設定と一致させます）。
9. Gatewayを起動します。Google Chatがウェブフックパスにリクエストを送信します。

## Google Chatに追加

Gatewayが実行中で、メールが可視性リストに追加されている場合:

1. [Google Chat](https://chat.google.com/)にアクセスします。
2. **Direct Messages**の横にある**+**（プラス）アイコンをクリックします。
3. 検索バー（通常は人を追加する場所）に、Google Cloud Consoleで設定した**App name**を入力します。
   - **注意**: ボットはプライベートアプリのため、「Marketplace」の閲覧リストには表示されません。名前で検索する必要があります。
4. 結果からボットを選択します。
5. **Add**または**Chat**をクリックして1対1の会話を開始します。
6. 「Hello」を送信してアシスタントをトリガーします。

## パブリックURL（ウェブフックのみ）

Google ChatウェブフックにはパブリックなHTTPSエンドポイントが必要です。セキュリティのため、**`/googlechat`パスのみ**をインターネットに公開してください。OpenClawダッシュボードやその他の機密エンドポイントはプライベートネットワーク上に保持してください。

### オプションA: Tailscale Funnel（推奨）

プライベートダッシュボードにはTailscale Serve、パブリックウェブフックパスにはFunnelを使用します。これにより`/`はプライベートのまま、`/googlechat`のみを公開できます。

1. **Gatewayがバインドされているアドレスを確認します:**

   ```bash
   ss -tlnp | grep 18789
   ```

   IPアドレスをメモします（例: `127.0.0.1`、`0.0.0.0`、またはTailscale IPの`100.x.x.x`）。

2. **ダッシュボードをtailnetのみに公開します（ポート8443）:**

   ```bash
   # localhostにバインドされている場合（127.0.0.1または0.0.0.0）:
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # Tailscale IPのみにバインドされている場合（例: 100.106.161.80）:
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **ウェブフックパスのみをパブリックに公開します:**

   ```bash
   # localhostにバインドされている場合（127.0.0.1または0.0.0.0）:
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # Tailscale IPのみにバインドされている場合（例: 100.106.161.80）:
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **ノードにFunnelアクセスを許可します:**
   プロンプトが表示された場合、出力に表示された認可URLにアクセスして、tailnetポリシーでこのノードのFunnelを有効にします。

5. **設定を確認します:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

パブリックウェブフックURL:
`https://<node-name>.<tailnet>.ts.net/googlechat`

プライベートダッシュボードはtailnetのみ:
`https://<node-name>.<tailnet>.ts.net:8443/`

Google Chatアプリの設定ではパブリックURL（`:8443`なし）を使用します。

> 注意: この設定は再起動後も永続します。後で削除するには、`tailscale funnel reset`と`tailscale serve reset`を実行してください。

### オプションB: リバースプロキシ（Caddy）

Caddyのようなリバースプロキシを使用する場合、特定のパスのみをプロキシします:

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

この設定では、`your-domain.com/`へのリクエストは無視または404が返され、`your-domain.com/googlechat`は安全にOpenClawにルーティングされます。

### オプションC: Cloudflare Tunnel

トンネルのイングレスルールを設定して、ウェブフックパスのみをルーティングします:

- **Path**: `/googlechat` -> `http://localhost:18789/googlechat`
- **Default Rule**: HTTP 404 (Not Found)

## 動作の仕組み

1. Google ChatがGatewayにウェブフックPOSTを送信します。各リクエストには`Authorization: Bearer <token>`ヘッダーが含まれます。
2. OpenClawは設定された`audienceType` + `audience`に対してトークンを検証します:
   - `audienceType: "app-url"` → オーディエンスはHTTPSウェブフックURL。
   - `audienceType: "project-number"` → オーディエンスはCloudプロジェクト番号。
3. メッセージはスペースごとにルーティングされます:
   - DMはセッションキー`agent:<agentId>:googlechat:dm:<spaceId>`を使用。
   - スペースはセッションキー`agent:<agentId>:googlechat:group:<spaceId>`を使用。
4. DMアクセスはデフォルトでペアリングです。未知の送信者にはペアリングコードが送信されます。承認方法:
   - `openclaw pairing approve googlechat <code>`
5. グループスペースはデフォルトで@メンションが必要です。メンション検出にアプリのユーザー名が必要な場合は`botUser`を使用してください。

## ターゲット

配信と許可リストには以下の識別子を使用します:

- ダイレクトメッセージ: `users/<userId>`（推奨）。
- 生のメール`name@example.com`はミュータブルであり、`channels.googlechat.dangerouslyAllowNameMatching: true`の場合にのみ直接許可リストマッチングに使用されます。
- 非推奨: `users/<email>`はユーザーIDとして扱われ、メール許可リストとしては扱われません。
- スペース: `spaces/<spaceId>`。

## 設定のハイライト

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      // または serviceAccountRef: { source: "file", provider: "filemain", id: "/channels/googlechat/serviceAccount" }
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // オプション。メンション検出に役立ちます
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890"],
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": {
          allow: true,
          requireMention: true,
          users: ["users/1234567890"],
          systemPrompt: "Short answers only.",
        },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

注意:

- サービスアカウントの認証情報は`serviceAccount`（JSON文字列）でインラインで渡すこともできます。
- `serviceAccountRef`もサポートされています（env/file SecretRef）。アカウントごとの`channels.googlechat.accounts.<id>.serviceAccountRef`も含みます。
- `webhookPath`が未設定の場合、デフォルトのウェブフックパスは`/googlechat`です。
- `dangerouslyAllowNameMatching`は、許可リストのミュータブルなメールプリンシパルマッチングを再有効化します（ブレイクグラス互換モード）。
- リアクションは`actions.reactions`が有効な場合、`reactions`ツールと`channels action`経由で利用可能です。
- `typingIndicator`は`none`、`message`（デフォルト）、`reaction`をサポートします（reactionにはユーザーOAuthが必要）。
- 添付ファイルはChat API経由でダウンロードされ、メディアパイプラインに保存されます（サイズは`mediaMaxMb`で制限）。

シークレットリファレンスの詳細: [シークレット管理](/gateway/secrets)

## トラブルシューティング

### 405 Method Not Allowed

Google Cloud Logs Explorerで以下のようなエラーが表示される場合:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

これはウェブフックハンドラーが登録されていないことを意味します。一般的な原因:

1. **チャンネルが設定されていない**: `channels.googlechat`セクションが設定にありません。確認方法:

   ```bash
   openclaw config get channels.googlechat
   ```

   「Config path not found」と返される場合は、設定を追加してください（[設定のハイライト](#設定のハイライト)を参照）。

2. **プラグインが有効でない**: プラグインのステータスを確認:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   「disabled」と表示される場合は、`plugins.entries.googlechat.enabled: true`を設定に追加してください。

3. **Gatewayが再起動されていない**: 設定の追加後、Gatewayを再起動してください:

   ```bash
   openclaw gateway restart
   ```

チャンネルが実行中であることを確認:

```bash
openclaw channels status
# 表示されるべき: Google Chat default: enabled, configured, ...
```

### その他の問題

- `openclaw channels status --probe`で認証エラーやオーディエンス設定の不足を確認してください。
- メッセージが届かない場合は、ChatアプリのウェブフックURL + イベントサブスクリプションを確認してください。
- メンションゲーティングが返信をブロックする場合は、`botUser`をアプリのユーザーリソース名に設定し、`requireMention`を確認してください。
- `openclaw logs --follow`でテストメッセージを送信しながらリクエストがGatewayに到達しているか確認してください。

関連ドキュメント:

- [Gateway設定](/gateway/configuration)
- [セキュリティ](/gateway/security)
- [リアクション](/tools/reactions)
