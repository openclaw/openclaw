---
summary: "ウェイクとアイソレーテッドエージェント実行のための Webhook インgresss"
read_when:
  - Webhook エンドポイントの追加または変更
  - 外部システムを OpenClaw に接続するとき
title: "Webhook"
---

# Webhook

Gateway は外部トリガー用の小さな HTTP Webhook エンドポイントを公開できます。

## 有効にする

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
    // オプション: 明示的な `agentId` ルーティングをこの許可リストに制限。
    // 省略するか "*" を含めると任意のエージェントを許可。
    // [] を設定すると明示的な `agentId` ルーティングをすべて拒否。
    allowedAgentIds: ["hooks", "main"],
  },
}
```

注意:

- `hooks.enabled=true` の場合、`hooks.token` は必須です。
- `hooks.path` のデフォルトは `/hooks` です。

## 認証

すべてのリクエストにフックトークンを含める必要があります。ヘッダーを推奨します:

- `Authorization: Bearer <token>`（推奨）
- `x-openclaw-token: <token>`
- クエリ文字列トークンは拒否されます（`?token=...` は `400` を返します）。

## エンドポイント

### `POST /hooks/wake`

ペイロード:

```json
{ "text": "System line", "mode": "now" }
```

- `text` **必須**（文字列）: イベントの説明（例: 「新しいメールを受信」）。
- `mode` オプション（`now` | `next-heartbeat`）: 即時ハートビートをトリガーするか（デフォルト `now`）、次の定期チェックを待つか。

効果:

- **メイン**セッションのシステムイベントをキューに追加
- `mode=now` の場合、即時ハートビートをトリガー

### `POST /hooks/agent`

ペイロード:

```json
{
  "message": "Run this",
  "name": "Email",
  "agentId": "hooks",
  "sessionKey": "hook:email:msg-123",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last",
  "to": "+15551234567",
  "model": "openai/gpt-5.2-mini",
  "thinking": "low",
  "timeoutSeconds": 120
}
```

- `message` **必須**（文字列）: エージェントが処理するプロンプトまたはメッセージ。
- `name` オプション（文字列）: フックの人間が読みやすい名前（例: 「GitHub」）。セッションサマリーのプレフィックスとして使用されます。
- `agentId` オプション（文字列）: このフックを特定のエージェントにルーティングします。不明な ID はデフォルトエージェントにフォールバックします。設定された場合、フックは解決されたエージェントのワークスペースと設定を使用して実行されます。
- `sessionKey` オプション（文字列）: エージェントのセッションを識別するために使用するキー。デフォルトでは `hooks.allowRequestSessionKey=true` でない限りこのフィールドは拒否されます。
- `wakeMode` オプション（`now` | `next-heartbeat`）: 即時ハートビートをトリガーするか（デフォルト `now`）、次の定期チェックを待つか。
- `deliver` オプション（ブーリアン）: `true` の場合、エージェントのレスポンスがメッセージングチャンネルに送信されます。デフォルトは `true`。ハートビートの確認応答のみのレスポンスは自動的にスキップされます。
- `channel` オプション（文字列）: デリバリー用のメッセージングチャンネル。`last`、`whatsapp`、`telegram`、`discord`、`slack`、`mattermost`（プラグイン）、`signal`、`imessage`、`msteams` のいずれか。デフォルトは `last`。
- `to` オプション（文字列）: チャンネルの受信者識別子（例: WhatsApp/Signal の電話番号、Telegram のチャット ID、Discord/Slack/Mattermost（プラグイン）のチャンネル ID、MS Teams の会話 ID）。デフォルトはメインセッションの最後の受信者。
- `model` オプション（文字列）: モデルオーバーライド（例: `anthropic/claude-3-5-sonnet` またはエイリアス）。制限されている場合は許可されたモデルリストに含まれている必要があります。
- `thinking` オプション（文字列）: シンキングレベルオーバーライド（例: `low`、`medium`、`high`）。
- `timeoutSeconds` オプション（数値）: エージェント実行の最大時間（秒）。

効果:

- **アイソレーテッド**エージェントターンを実行（独自のセッションキー）
- **メイン**セッションにサマリーを常に投稿
- `wakeMode=now` の場合、即時ハートビートをトリガー

## セッションキーポリシー（破壊的変更）

`/hooks/agent` ペイロードの `sessionKey` オーバーライドはデフォルトで無効になっています。

- 推奨: 固定の `hooks.defaultSessionKey` を設定してリクエストオーバーライドをオフに保つ。
- オプション: 必要な場合のみリクエストオーバーライドを許可し、プレフィックスを制限する。

推奨設定:

```json5
{
  hooks: {
    enabled: true,
    token: "${OPENCLAW_HOOKS_TOKEN}",
    defaultSessionKey: "hook:ingress",
    allowRequestSessionKey: false,
    allowedSessionKeyPrefixes: ["hook:"],
  },
}
```

互換性設定（レガシー動作）:

```json5
{
  hooks: {
    enabled: true,
    token: "${OPENCLAW_HOOKS_TOKEN}",
    allowRequestSessionKey: true,
    allowedSessionKeyPrefixes: ["hook:"], // 強く推奨
  },
}
```

### `POST /hooks/<name>`（マップ済み）

カスタムフック名は `hooks.mappings` を通じて解決されます（設定参照）。マッピングは任意のペイロードをオプションのテンプレートまたはコードトランスフォームを使用して `wake` または `agent` アクションに変換できます。

マッピングオプション（サマリー）:

- `hooks.presets: ["gmail"]` は組み込みの Gmail マッピングを有効にします。
- `hooks.mappings` を使用すると設定で `match`、`action`、テンプレートを定義できます。
- `hooks.transformsDir` + `transform.module` でカスタムロジック用の JS/TS モジュールを読み込みます。
  - `hooks.transformsDir`（設定されている場合）は OpenClaw 設定ディレクトリ（通常 `~/.openclaw/hooks/transforms`）の transforms ルート内に留まる必要があります。
  - `transform.module` は有効な transforms ディレクトリ内で解決される必要があります（トラバーサル/エスケープパスは拒否されます）。
- `match.source` を使用してジェネリックなインジェストエンドポイントを維持します（ペイロード駆動のルーティング）。
- TS トランスフォームにはランタイムで TS ローダー（例: `bun` または `tsx`）またはプリコンパイル済みの `.js` が必要です。
- マッピングに `deliver: true` + `channel`/`to` を設定してチャットサーフェスに返信をルーティングします（`channel` のデフォルトは `last`、WhatsApp にフォールバック）。
- `agentId` はフックを特定のエージェントにルーティングします。不明な ID はデフォルトエージェントにフォールバックします。
- `hooks.allowedAgentIds` は明示的な `agentId` ルーティングを制限します。省略（または `*` を含める）すると任意のエージェントを許可します。明示的な `agentId` ルーティングを拒否するには `[]` を設定します。
- `hooks.defaultSessionKey` は明示的なキーが提供されない場合のフックエージェント実行のデフォルトセッションを設定します。
- `hooks.allowRequestSessionKey` は `/hooks/agent` ペイロードが `sessionKey` を設定できるかどうかを制御します（デフォルト: `false`）。
- `hooks.allowedSessionKeyPrefixes` はリクエストペイロードとマッピングからの明示的な `sessionKey` 値をオプションで制限します。
- `allowUnsafeExternalContent: true` はそのフックの外部コンテンツ安全ラッパーを無効にします（危険; 信頼できる内部ソースのみ）。
- `openclaw webhooks gmail setup` は `openclaw webhooks gmail run` 用の `hooks.gmail` 設定を書き込みます。完全な Gmail ウォッチフローは [Gmail Pub/Sub](/automation/gmail-pubsub) を参照してください。

## レスポンス

- `/hooks/wake` に対して `200`
- `/hooks/agent` に対して `202`（非同期実行開始）
- 認証失敗に対して `401`
- 同じクライアントからの繰り返し認証失敗後に `429`（`Retry-After` を確認）
- 無効なペイロードに対して `400`
- 過大なペイロードに対して `413`

## 例

```bash
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"New email received","mode":"now"}'
```

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","wakeMode":"next-heartbeat"}'
```

### 異なるモデルを使用する

エージェントペイロード（またはマッピング）に `model` を追加して、その実行のモデルをオーバーライドします:

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

`agents.defaults.models` を適用している場合は、オーバーライドモデルがそこに含まれていることを確認してください。

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## セキュリティ

- フックエンドポイントをループバック、テイルネット、または信頼できるリバースプロキシの背後に保ちます。
- 専用のフックトークンを使用してください。Gateway 認証トークンを再利用しないでください。
- ブルートフォース攻撃を遅らせるために、クライアントアドレスごとに繰り返し認証失敗がレート制限されます。
- マルチエージェントルーティングを使用する場合は、`hooks.allowedAgentIds` を設定して明示的な `agentId` の選択を制限してください。
- 呼び出し元が選択したセッションが必要でない限り、`hooks.allowRequestSessionKey=false` を維持してください。
- リクエスト `sessionKey` を有効にする場合は、`hooks.allowedSessionKeyPrefixes` を制限してください（例: `["hook:"]`）。
- Webhook ログに機密性の高い生のペイロードを含めないようにしてください。
- フックペイロードはデフォルトで信頼されていないものとして扱われ、安全境界でラップされます。特定のフックでこれを無効にする必要がある場合は、そのフックのマッピングで `allowUnsafeExternalContent: true` を設定してください（危険）。
