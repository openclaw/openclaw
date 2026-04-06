---
summary: "Mattermost ボットのセットアップと OpenClaw の設定"
read_when:
  - Mattermost のセットアップ時
  - Mattermost ルーティングのデバッグ時
title: "Mattermost"
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: 924de8c55e1454e02ff9432b46614e012bf2522fd1266e45159aad779b9bb442
    source_path: channels/mattermost.md
    workflow: 15
---

# Mattermost（プラグイン）

ステータス: プラグイン経由でサポートされています（ボットトークン + WebSocket イベント）。チャンネル、グループ、DM がサポートされています。
Mattermost はセルフホスト可能なチームメッセージングプラットフォームです。製品詳細とダウンロードについては公式サイト [mattermost.com](https://mattermost.com) を参照してください。

## プラグインが必要

Mattermost はプラグインとして提供されており、コアインストールにはバンドルされていません。

CLI 経由でインストール（npm レジストリ）:

```bash
openclaw plugins install @openclaw/mattermost
```

ローカルチェックアウト（git リポジトリから実行する場合）:

```bash
openclaw plugins install ./path/to/local/mattermost-plugin
```

セットアップ時に Mattermost を選択し、git チェックアウトが検出された場合、
OpenClaw は自動的にローカルインストールパスを提案します。

詳細: [Plugins](/tools/plugin)

## クイックセットアップ

1. Mattermost プラグインをインストールします。
2. Mattermost ボットアカウントを作成して**ボットトークン**をコピーします。
3. Mattermost の**ベース URL**をコピーします（例: `https://chat.example.com`）。
4. OpenClaw を設定して Gateway ゲートウェイを起動します。

最小限の設定:

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
    },
  },
}
```

## ネイティブスラッシュコマンド

ネイティブスラッシュコマンドはオプトインです。有効にすると、OpenClaw は Mattermost API を介して `oc_*` スラッシュコマンドを登録し、Gateway ゲートウェイ HTTP サーバーでコールバック POST を受信します。

```json5
{
  channels: {
    mattermost: {
      commands: {
        native: true,
        nativeSkills: true,
        callbackPath: "/api/channels/mattermost/command",
        // Mattermost が Gateway ゲートウェイに直接アクセスできない場合に使用（リバースプロキシ/公開 URL）。
        callbackUrl: "https://gateway.example.com/api/channels/mattermost/command",
      },
    },
  },
}
```

注意:

- `native: "auto"` は Mattermost のデフォルトでは無効になっています。有効にするには `native: true` を設定してください。
- `callbackUrl` が省略された場合、OpenClaw は Gateway ゲートウェイのホスト/ポート + `callbackPath` から導出します。
- マルチアカウント設定では、`commands` はトップレベルまたは `channels.mattermost.accounts.<id>.commands` の下に設定できます（アカウントの値はトップレベルのフィールドを上書きします）。
- コマンドコールバックはコマンドごとのトークンで検証され、トークンチェックが失敗すると失敗して閉じられます。
- 到達可能性の要件: コールバックエンドポイントは Mattermost サーバーから到達可能である必要があります。
  - Mattermost が OpenClaw と同じホスト/ネットワーク名前空間で実行されていない限り、`callbackUrl` を `localhost` に設定しないでください。
  - その URL が `/api/channels/mattermost/command` を OpenClaw にリバースプロキシしている場合を除き、`callbackUrl` を Mattermost のベース URL に設定しないでください。
  - 簡単なチェック: `curl https://<gateway-host>/api/channels/mattermost/command` を実行して、GET が OpenClaw から `405 Method Not Allowed`（`404` ではなく）を返すことを確認してください。
- Mattermost のエグレス許可リスト要件:
  - コールバックがプライベート/tailnet/内部アドレスをターゲットにしている場合は、Mattermost
    `ServiceSettings.AllowedUntrustedInternalConnections` にコールバックホスト/ドメインを含めるように設定してください。
  - ホスト/ドメインエントリを使用し、完全な URL は使用しないでください。
    - 良い例: `gateway.tailnet-name.ts.net`
    - 悪い例: `https://gateway.tailnet-name.ts.net`

## 環境変数（デフォルトアカウント）

環境変数を使用する場合は Gateway ゲートウェイホストで設定します:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

環境変数は**デフォルト**アカウント（`default`）にのみ適用されます。他のアカウントは設定値を使用する必要があります。

## チャットモード

Mattermost は DM に自動で応答します。チャンネルの動作は `chatmode` で制御されます:

- `oncall`（デフォルト）: チャンネルで @メンションされた場合のみ応答します。
- `onmessage`: すべてのチャンネルメッセージに応答します。
- `onchar`: メッセージがトリガープレフィックスで始まる場合に応答します。

設定例:

```json5
{
  channels: {
    mattermost: {
      chatmode: "onchar",
      oncharPrefixes: [">", "!"],
    },
  },
}
```

注意:

- `onchar` は明示的な @メンションにも引き続き応答します。
- `channels.mattermost.requireMention` はレガシー設定でも有効ですが、`chatmode` が推奨されます。

## スレッドとセッション

`channels.mattermost.replyToMode` を使用して、チャンネルおよびグループの返信がメインチャンネルに留まるか、トリガーとなった投稿の下にスレッドを開始するかを制御します。

- `off`（デフォルト）: インバウンド投稿が既にスレッド内にある場合のみスレッドで返信します。
- `first`: トップレベルのチャンネル/グループ投稿の場合、その投稿の下にスレッドを開始し、会話をスレッドスコープのセッションにルーティングします。
- `all`: 現在の Mattermost では `first` と同じ動作です。
- ダイレクトメッセージはこの設定を無視して非スレッドのままです。

設定例:

```json5
{
  channels: {
    mattermost: {
      replyToMode: "all",
    },
  },
}
```

注意:

- スレッドスコープのセッションは、トリガーとなった投稿 ID をスレッドルートとして使用します。
- Mattermost にスレッドルートがある場合、フォローアップのチャンクとメディアは同じスレッドで継続するため、`first` と `all` は現在同等です。

## アクセス制御（DM）

- デフォルト: `channels.mattermost.dmPolicy = "pairing"`（未知の送信者にはペアリングコードが届きます）。
- 以下で承認します:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- 公開 DM: `channels.mattermost.dmPolicy="open"` と `channels.mattermost.allowFrom=["*"]`。

## チャンネル（グループ）

- デフォルト: `channels.mattermost.groupPolicy = "allowlist"`（メンションゲート付き）。
- `channels.mattermost.groupAllowFrom` で送信者を許可リストに追加します（ユーザー ID 推奨）。
- `@username` マッチングは変更可能であり、`channels.mattermost.dangerouslyAllowNameMatching: true` の場合のみ有効です。
- オープンチャンネル: `channels.mattermost.groupPolicy="open"`（メンションゲート付き）。
- ランタイムノート: `channels.mattermost` が完全に欠落している場合、ランタイムはグループチェックで `groupPolicy="allowlist"` にフォールバックします（`channels.defaults.groupPolicy` が設定されていても）。

## アウトバウンド配信のターゲット

`openclaw message send` やクロン/Webhook で以下のターゲット形式を使用します:

- `channel:<id>` でチャンネル
- `user:<id>` で DM
- `@username` で DM（Mattermost API 経由で解決）

裸の不透明な ID（`64ifufp...` のような）は Mattermost では**曖昧**です（ユーザー ID 対チャンネル ID）。

OpenClaw は**ユーザー優先**で解決します:

- ID がユーザーとして存在する場合（`GET /api/v4/users/<id>` が成功）、OpenClaw は `/api/v4/channels/direct` 経由でダイレクトチャンネルを解決して **DM** を送信します。
- それ以外の場合、ID は**チャンネル ID** として扱われます。

確定的な動作が必要な場合は、常に明示的なプレフィックス（`user:<id>` / `channel:<id>`）を使用してください。

## DM チャンネルのリトライ

OpenClaw が Mattermost DM ターゲットに送信し、最初にダイレクトチャンネルを解決する必要がある場合、デフォルトでは一時的なダイレクトチャンネル作成の失敗をリトライします。

`channels.mattermost.dmChannelRetry` でその動作を Mattermost プラグイン全体に対してチューニングするか、`channels.mattermost.accounts.<id>.dmChannelRetry` で 1 つのアカウントに対して設定します。

```json5
{
  channels: {
    mattermost: {
      dmChannelRetry: {
        maxRetries: 3,
        initialDelayMs: 1000,
        maxDelayMs: 10000,
        timeoutMs: 30000,
      },
    },
  },
}
```

注意:

- これはすべての Mattermost API 呼び出しではなく、DM チャンネル作成（`/api/v4/channels/direct`）にのみ適用されます。
- リトライはレート制限、5xx 応答、ネットワークまたはタイムアウトエラーなどの一時的な失敗に適用されます。
- `429` 以外の 4xx クライアントエラーは永続的として扱われ、リトライされません。

## リアクション（メッセージツール）

- `channel=mattermost` で `message action=react` を使用します。
- `messageId` は Mattermost の投稿 ID です。
- `emoji` は `thumbsup` や `:+1:` のような名前を受け付けます（コロンはオプション）。
- リアクションを削除するには `remove=true`（ブール値）を設定します。
- リアクションの追加/削除イベントはシステムイベントとしてルーティングされたエージェントセッションに転送されます。

例:

```
message action=react channel=mattermost target=channel:<channelId> messageId=<postId> emoji=thumbsup
message action=react channel=mattermost target=channel:<channelId> messageId=<postId> emoji=thumbsup remove=true
```

設定:

- `channels.mattermost.actions.reactions`: リアクションアクションを有効/無効にします（デフォルト true）。
- アカウントごとの上書き: `channels.mattermost.accounts.<id>.actions.reactions`。

## インタラクティブボタン（メッセージツール）

クリック可能なボタン付きのメッセージを送信します。ユーザーがボタンをクリックすると、エージェントが選択内容を受け取って応答できます。

チャンネルのケイパビリティに `inlineButtons` を追加してボタンを有効にします:

```json5
{
  channels: {
    mattermost: {
      capabilities: ["inlineButtons"],
    },
  },
}
```

`buttons` パラメーターを使用して `message action=send` を実行します。ボタンは 2D 配列（ボタンの行）です:

```
message action=send channel=mattermost target=channel:<channelId> buttons=[[{"text":"Yes","callback_data":"yes"},{"text":"No","callback_data":"no"}]]
```

ボタンフィールド:

- `text`（必須）: 表示ラベル。
- `callback_data`（必須）: クリック時に返される値（アクション ID として使用）。
- `style`（オプション）: `"default"`、`"primary"`、または `"danger"`。

ユーザーがボタンをクリックすると:

1. すべてのボタンが確認行に置き換えられます（例: "✓ **Yes** selected by @user"）。
2. エージェントは選択内容をインバウンドメッセージとして受け取り、応答します。

注意:

- ボタンコールバックは HMAC-SHA256 検証を使用します（自動、設定不要）。
- Mattermost は API 応答からコールバックデータを削除します（セキュリティ機能）。そのため、クリック時にすべてのボタンが削除されます—部分的な削除は不可能です。
- ハイフンやアンダースコアを含むアクション ID は自動的にサニタイズされます（Mattermost のルーティング制限）。

設定:

- `channels.mattermost.capabilities`: ケイパビリティ文字列の配列。ボタンツールの説明をエージェントシステムプロンプトに追加するには `"inlineButtons"` を追加します。
- `channels.mattermost.interactions.callbackBaseUrl`: ボタンコールバック用のオプションの外部ベース URL（例: `https://gateway.example.com`）。Mattermost が Gateway ゲートウェイのバインドホストに直接アクセスできない場合に使用します。
- マルチアカウント設定では、`channels.mattermost.accounts.<id>.interactions.callbackBaseUrl` の下に同じフィールドを設定することもできます。
- `interactions.callbackBaseUrl` が省略された場合、OpenClaw は `gateway.customBindHost` + `gateway.port` からコールバック URL を導出し、`http://localhost:<port>` にフォールバックします。
- 到達可能性ルール: ボタンコールバック URL は Mattermost サーバーから到達可能である必要があります。
  `localhost` は Mattermost と OpenClaw が同じホスト/ネットワーク名前空間で実行されている場合のみ機能します。
- コールバックターゲットがプライベート/tailnet/内部の場合は、そのホスト/ドメインを Mattermost
  `ServiceSettings.AllowedUntrustedInternalConnections` に追加してください。

### 直接 API 統合（外部スクリプト）

外部スクリプトと Webhook は、エージェントの `message` ツールを経由せずに Mattermost REST API を通じて直接ボタンを投稿できます。可能な場合は拡張機能の `buildButtonAttachments()` を使用してください。生の JSON を投稿する場合は、次のルールに従ってください:

**ペイロード構造:**

```json5
{
  channel_id: "<channelId>",
  message: "Choose an option:",
  props: {
    attachments: [
      {
        actions: [
          {
            id: "mybutton01", // 英数字のみ — 以下を参照
            type: "button", // 必須、ないとクリックが黙って無視される
            name: "Approve", // 表示ラベル
            style: "primary", // オプション: "default", "primary", "danger"
            integration: {
              url: "https://gateway.example.com/mattermost/interactions/default",
              context: {
                action_id: "mybutton01", // ボタン ID と一致する必要がある（名前検索用）
                action: "approve",
                // ... カスタムフィールド ...
                _token: "<hmac>", // HMAC セクションを参照
              },
            },
          },
        ],
      },
    ],
  },
}
```

**重要なルール:**

1. 添付ファイルは `props.attachments` に入れます。トップレベルの `attachments` ではありません（黙って無視されます）。
2. すべてのアクションに `type: "button"` が必要です — ないとクリックが黙って飲み込まれます。
3. すべてのアクションに `id` フィールドが必要です — Mattermost は ID のないアクションを無視します。
4. アクションの `id` は**英数字のみ**（`[a-zA-Z0-9]`）でなければなりません。ハイフンとアンダースコアは Mattermost のサーバー側アクションルーティングを壊します（404 を返します）。使用前に取り除いてください。
5. `context.action_id` はボタンの `id` と一致する必要があります。これにより確認メッセージが生の ID ではなくボタン名（例: "Approve"）を表示します。
6. `context.action_id` は必須です — インタラクションハンドラーはこれなしに 400 を返します。

**HMAC トークン生成:**

Gateway ゲートウェイは HMAC-SHA256 でボタンクリックを検証します。外部スクリプトは Gateway ゲートウェイの検証ロジックと一致するトークンを生成する必要があります:

1. ボットトークンからシークレットを導出:
   `HMAC-SHA256(key="openclaw-mattermost-interactions", data=botToken)`
2. `_token` を除くすべてのフィールドでコンテキストオブジェクトを構築します。
3. **ソートされたキー**と**スペースなし**でシリアライズします（Gateway ゲートウェイはソートされたキーで `JSON.stringify` を使用しており、コンパクトな出力を生成します）。
4. 署名: `HMAC-SHA256(key=secret, data=serializedContext)`
5. 結果の 16 進ダイジェストをコンテキストに `_token` として追加します。

Python の例:

```python
import hmac, hashlib, json

secret = hmac.new(
    b"openclaw-mattermost-interactions",
    bot_token.encode(), hashlib.sha256
).hexdigest()

ctx = {"action_id": "mybutton01", "action": "approve"}
payload = json.dumps(ctx, sort_keys=True, separators=(",", ":"))
token = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()

context = {**ctx, "_token": token}
```

一般的な HMAC の落とし穴:

- Python の `json.dumps` はデフォルトでスペースを追加します（`{"key": "val"}`）。JavaScript のコンパクトな出力（`{"key":"val"}`）に合わせるには `separators=(",", ":")` を使用してください。
- 常に**すべて**のコンテキストフィールド（`_token` を除く）に署名してください。Gateway ゲートウェイは `_token` を取り除いてから残りすべてに署名します。サブセットに署名すると黙って検証が失敗します。
- `sort_keys=True` を使用してください — Gateway ゲートウェイは署名前にキーをソートします。Mattermost はペイロードを保存するときにコンテキストフィールドを並べ替える場合があります。
- ボットトークンからシークレットを導出してください（確定的）。ランダムなバイトは使用しないでください。シークレットはボタンを作成するプロセスと検証する Gateway ゲートウェイで同一でなければなりません。

## ディレクトリアダプター

Mattermost プラグインには、Mattermost API を通じてチャンネルとユーザー名を解決するディレクトリアダプターが含まれています。これにより `openclaw message send` とクロン/Webhook 配信で `#channel-name` と `@username` ターゲットが使用できます。

設定は不要です — アダプターはアカウント設定のボットトークンを使用します。

## マルチアカウント

Mattermost は `channels.mattermost.accounts` で複数のアカウントをサポートします:

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## トラブルシューティング

- チャンネルで返信がない: ボットがチャンネルにいることを確認し、メンションする（oncall）か、トリガープレフィックスを使用する（onchar）か、`chatmode: "onmessage"` を設定してください。
- 認証エラー: ボットトークン、ベース URL、アカウントが有効かどうかを確認してください。
- マルチアカウントの問題: 環境変数は `default` アカウントにのみ適用されます。
- ボタンが白いボックスとして表示される: エージェントが不正なボタンデータを送信している可能性があります。各ボタンに `text` と `callback_data` フィールドの両方があることを確認してください。
- ボタンがレンダリングされるがクリックしても何も起きない: Mattermost サーバー設定の `AllowedUntrustedInternalConnections` に `127.0.0.1 localhost` が含まれており、ServiceSettings で `EnablePostActionIntegration` が `true` であることを確認してください。
- クリック時にボタンが 404 を返す: ボタンの `id` にハイフンまたはアンダースコアが含まれている可能性があります。Mattermost のアクションルーターは英数字以外の ID では壊れます。`[a-zA-Z0-9]` のみを使用してください。
- Gateway ゲートウェイが `invalid _token` をログに記録する: HMAC の不一致です。すべてのコンテキストフィールド（サブセットではなく）に署名し、ソートされたキーと コンパクトな JSON（スペースなし）を使用していることを確認してください。上記の HMAC セクションを参照してください。
- Gateway ゲートウェイが `missing _token in context` をログに記録する: `_token` フィールドがボタンのコンテキストにありません。統合ペイロードを構築するときに含まれていることを確認してください。
- 確認にボタン名ではなく生の ID が表示される: `context.action_id` がボタンの `id` と一致していません。両方を同じサニタイズされた値に設定してください。
- エージェントがボタンについて知らない: Mattermost チャンネル設定に `capabilities: ["inlineButtons"]` を追加してください。

## 関連項目

- [Channels Overview](/channels) — サポートされているすべてのチャンネル
- [Pairing](/channels/pairing) — DM 認証とペアリングフロー
- [Groups](/channels/groups) — グループチャットの動作とメンションゲート
- [Channel Routing](/channels/channel-routing) — メッセージのセッションルーティング
- [Security](/gateway/security) — アクセスモデルとハードニング
