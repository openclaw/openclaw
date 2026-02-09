---
summary: "Google Chat アプリのサポート状況、機能、および設定"
read_when:
  - Google Chat チャンネル機能の作業時
title: "Google Chat"
---

# Google Chat（Chat API）

ステータス: Google Chat API の Webhook（HTTP のみ）経由で、DM とスペースに対応済みです。

## クイックセットアップ（初心者）

1. Google Cloud プロジェクトを作成し、**Google Chat API** を有効化します。
   - こちらへ移動: [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - まだ有効でない場合は API を有効化します。
2. **Service Account** を作成します。
   - **Create Credentials** > **Service Account** をクリックします。
   - 任意の名前を付けます（例: `openclaw-chat`）。
   - 権限は空欄のままにします（**Continue** を押します）。
   - アクセス権を持つプリンシパルも空欄のままにします（**Done** を押します）。
3. **JSON Key** を作成してダウンロードします。
   - Service Account の一覧から、作成したものをクリックします。
   - **Keys** タブに移動します。
   - **Add Key** > **Create new key** をクリックします。
   - **JSON** を選択して **Create** を押します。
4. ダウンロードした JSON ファイルをゲートウェイ ホストに保存します（例: `~/.openclaw/googlechat-service-account.json`）。
5. [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat) で Google Chat アプリを作成します。
   - **Application info** を入力します。
     - **App name**:（例: `OpenClaw`）
     - **Avatar URL**:（例: `https://openclaw.ai/logo.png`）
     - **Description**:（例: `Personal AI Assistant`）
   - **Interactive features** を有効化します。
   - **Functionality** で **Join spaces and group conversations** にチェックします。
   - **Connection settings** で **HTTP endpoint URL** を選択します。
   - **Triggers** で **Use a common HTTP endpoint URL for all triggers** を選択し、ゲートウェイの公開 URL に続けて `/googlechat` を設定します。
     - _ヒント: `openclaw status` を実行すると、ゲートウェイの公開 URL を確認できます。_
   - **Visibility** で **Make this Chat app available to specific people and groups in &lt;Your Domain&gt;** にチェックします。
   - テキストボックスに自分のメールアドレス（例: `user@example.com`）を入力します。
   - 画面下部の **Save** をクリックします。
6. **アプリのステータスを有効化**します。
   - 保存後、**ページを更新**します。
   - **App status** セクション（保存後、通常は上部または下部に表示されます）を探します。
   - ステータスを **Live - available to users** に変更します。
   - 再度 **Save** をクリックします。
7. Service Account のパスと Webhook audience を使って OpenClaw を設定します。
   - Env: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - または config: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`。
8. Webhook audience のタイプと値を設定します（Chat アプリの設定と一致させます）。
9. ゲートウェイを起動します。 GoogleチャットはWebhookのパスにPOSTします。

## Google Chat に追加

ゲートウェイが稼働しており、可視性リストに自分のメールが追加されている場合:

1. [Google Chat](https://chat.google.com/) に移動します。
2. **Direct Messages** の横にある **+**（プラス）アイコンをクリックします。
3. 検索バー（通常人を追加する場所）に、Google Cloud Console で設定した **App name** を入力します。
   - **注記**: このボットはプライベートアプリのため、「Marketplace」の一覧には表示されません。名前で検索する必要があります。 名前で検索する必要があります。
4. 検索結果からボットを選択します。
5. **Add** または **Chat** をクリックして 1:1 の会話を開始します。
6. 「Hello」を送信してアシスタントを起動します。

## 公開 URL（Webhook のみ）

Google Chat の Webhook には公開 HTTPS エンドポイントが必要です。セキュリティのため、**インターネットに公開するのは `/googlechat` パスのみ**にしてください。OpenClaw ダッシュボードやその他の機密エンドポイントは、プライベートネットワーク上に保持します。 セキュリティのため、**`/googlechat`のパス**だけをインターネットに公開します。 OpenClawダッシュボードやその他の機密性の高いエンドポイントをプライベートネットワーク上に保持します。

### オプション A: Tailscale Funnel（推奨）

プライベートなダッシュボードには Tailscale Serve、公開 Webhook パスには Funnel を使用します。これにより `/` を非公開のまま、`/googlechat` のみを公開できます。 `/`は`/googlechat`のみを公開しています。

1. **ゲートウェイがどのアドレスにバインドされているか確認します。**

   ```bash
   ss -tlnp | grep 18789
   ```

   IP アドレス（例: `127.0.0.1`、`0.0.0.0`、または `100.x.x.x` のような Tailscale IP）をメモします。

2. **ダッシュボードを tailnet のみに公開します（ポート 8443）。**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **Webhook パスのみを公開します。**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **ノードを Funnel アクセス用に承認します。**
   プロンプトが表示された場合は、出力に表示される承認 URL にアクセスして、tailnet ポリシーでこのノードの Funnel を有効化します。

5. **設定を確認します。**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

公開 Webhook URL は次のとおりです:
`https://<node-name>.<tailnet>.ts.net/googlechat`

プライベートなダッシュボードは tailnet のみに保たれます:
`https://<node-name>.<tailnet>.ts.net:8443/`

Google Chat アプリの設定では、公開 URL（`:8443` を除く）を使用します。

> 注:この設定はリブート間で持続します。 注記: この設定は再起動後も保持されます。後で削除するには、`tailscale funnel reset` と `tailscale serve reset` を実行します。

### オプション B: リバースプロキシ（Caddy）

Caddy のようなリバースプロキシを使用する場合は、特定のパスのみをプロキシします。

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

この設定では、`your-domain.com/` へのリクエストは無視されるか 404 が返され、`your-domain.com/googlechat` のみが安全に OpenClaw にルーティングされます。

### オプション C: Cloudflare Tunnel

トンネルの ingress ルールを設定し、Webhook パスのみをルーティングします。

- **Path**: `/googlechat` -> `http://localhost:18789/googlechat`
- **Default Rule**: HTTP 404（Not Found）

## How it works

1. ゲートウェイを起動します。Google Chat は Webhook パスに POST を送信します。 各リクエストには `Authorization: Bearer <token>` ヘッダーが含まれています。
2. OpenClaw は、設定された `audienceType` と `audience` に対してトークンを検証します。
   - `audienceType: "app-url"` → audience は HTTPS の Webhook URL です。
   - `audienceType: "project-number"` → audience は Cloud プロジェクト番号です。
3. メッセージはスペースごとにルーティングされます。
   - DM はセッションキー `agent:<agentId>:googlechat:dm:<spaceId>` を使用します。
   - スペースはセッションキー `agent:<agentId>:googlechat:group:<spaceId>` を使用します。
4. DMアクセスはデフォルトでペアリングされています。 不明な送信者はペアリングコードを受け取ります。以下を承認してください：
   - `openclaw pairing approve googlechat <code>`
5. グループスペースにはデフォルトで@-メンションが必要です。 グループスペースでは、デフォルトで @ メンションが必要です。メンション検出にアプリのユーザー名が必要な場合は `botUser` を使用します。

## 対象

配信および許可リストには、次の識別子を使用します。

- ダイレクトメッセージ: `users/<userId>` または `users/<email>`（メールアドレスも使用できます）。
- スペース: `spaces/<spaceId>`。

## 設定の要点

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; helps mention detection
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890", "name@example.com"],
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

注記:

- Service Account の認証情報は、`serviceAccount`（JSON 文字列）でインライン指定することもできます。
- デフォルトの Webhook パスは、`webhookPath` が設定されていない場合、`/googlechat` です。
- リアクションは、`actions.reactions` が有効な場合に `reactions` ツールおよび `channels action` で利用できます。
- `typingIndicator` は `none`、`message`（デフォルト）、および `reaction` をサポートします（リアクションにはユーザー OAuth が必要です）。
- 添付ファイルは Chat API 経由でダウンロードされ、メディアパイプラインに保存されます（サイズは `mediaMaxMb` により制限されます）。

## トラブルシューティング

### 405 Method Not Allowed

Google Cloud Logs Explorer に次のようなエラーが表示される場合:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

これは Webhook ハンドラーが登録されていないことを意味します。一般的な原因は次のとおりです。 よくある原因:

1. **チャンネルが未設定**: 設定に `channels.googlechat` セクションがありません。次で確認します。 以下の認証を行います。

   ```bash
   openclaw config get channels.googlechat
   ```

   「Config path not found」と返る場合は、設定を追加してください（[設定の要点](#config-highlights) を参照）。

2. **プラグインが有効でない**: プラグインの状態を確認します。

   ```bash
   openclaw plugins list | grep googlechat
   ```

   「disabled」と表示される場合は、`plugins.entries.googlechat.enabled: true` を設定に追加します。

3. **ゲートウェイが再起動されていない**: 設定追加後にゲートウェイを再起動します。

   ```bash
   openclaw gateway restart
   ```

チャンネルが稼働していることを確認します。

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### その他の問題

- 認証エラーや audience 設定の不足については `openclaw channels status --probe` を確認します。
- メッセージが届かない場合は、Chat アプリの Webhook URL とイベントサブスクリプションを確認します。
- メンション制御により返信がブロックされる場合は、`botUser` をアプリのユーザーリソース名に設定し、`requireMention` を確認します。
- テストメッセージ送信時に `openclaw logs --follow` を使用して、リクエストがゲートウェイに到達しているか確認します。

関連ドキュメント:

- [Gateway 設定](/gateway/configuration)
- [セキュリティ](/gateway/security)
- [リアクション](/tools/reactions)
