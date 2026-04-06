---
read_when:
    - Webhookエンドポイントの追加または変更
    - 外部システムをOpenClawに接続する
summary: 外部トリガーによるウェイクおよび分離エージェント実行のためのWebhookイングレス
title: Webhooks
x-i18n:
    generated_at: "2026-04-02T07:31:29Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 5c5784212a2bae94714641720c9c4d97089c206574c5cdd5d905ef7333121f91
    source_path: automation/webhook.md
    workflow: 15
---

# Webhooks

Gateway ゲートウェイは、外部トリガー用の小さなHTTP Webhookエンドポイントを公開できます。

## 有効化

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
    // オプション: 明示的な `agentId` ルーティングをこの許可リストに制限します。
    // 省略するか "*" を含めると、すべてのエージェントを許可します。
    // [] に設定すると、すべての明示的な `agentId` ルーティングを拒否します。
    allowedAgentIds: ["hooks", "main"],
  },
}
```

注意事項:

- `hooks.enabled=true` の場合、`hooks.token` は必須です。
- `hooks.path` のデフォルトは `/hooks` です。

## 認証

すべてのリクエストにフックトークンを含める必要があります。ヘッダーの使用を推奨します:

- `Authorization: Bearer <token>`（推奨）
- `x-openclaw-token: <token>`
- クエリ文字列トークンは拒否されます（`?token=...` は `400` を返します）。
- `hooks.token` の保持者は、そのGateway ゲートウェイ上のフックイングレスサーフェスに対する完全信頼の呼び出し元として扱われます。フックペイロードの内容は引き続き信頼されませんが、これは別の非オーナー認証境界ではありません。

## エンドポイント

### `POST /hooks/wake`

ペイロード:

```json
{ "text": "System line", "mode": "now" }
```

- `text` **必須**（string）: イベントの説明（例: 「新しいメールを受信しました」）。
- `mode` オプション（`now` | `next-heartbeat`）: 即時ハートビートをトリガーするか（デフォルト `now`）、次の定期チェックまで待つか。

効果:

- **メイン**セッションのシステムイベントをキューに入れる
- `mode=now` の場合、即時ハートビートをトリガーする

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

- `message` **必須**（string）: エージェントが処理するプロンプトまたはメッセージ。
- `name` オプション（string）: フックの人間が読める名前（例: 「GitHub」）。セッション要約のプレフィックスとして使用されます。
- `agentId` オプション（string）: このフックを特定のエージェントにルーティングします。不明なIDはデフォルトエージェントにフォールバックします。設定すると、フックは解決されたエージェントのワークスペースと設定を使用して実行されます。
- `sessionKey` オプション（string）: エージェントのセッションを識別するために使用されるキー。デフォルトでは、`hooks.allowRequestSessionKey=true` でない限りこのフィールドは拒否されます。
- `wakeMode` オプション（`now` | `next-heartbeat`）: 即時ハートビートをトリガーするか（デフォルト `now`）、次の定期チェックまで待つか。
- `deliver` オプション（boolean）: `true` の場合、エージェントの応答がメッセージングチャネルに送信されます。デフォルトは `true` です。ハートビートの確認応答のみの応答は自動的にスキップされます。
- `channel` オプション（string）: 配信用のメッセージングチャネル。`last` または設定済みのチャネルやプラグインID（例: `discord`、`matrix`、`telegram`、`whatsapp`）を使用します。デフォルトは `last` です。
- `to` オプション（string）: チャネルの受信者識別子（例: WhatsApp/Signalの電話番号、Telegramのチャットid、Discord/Slack/Mattermost（プラグイン）のチャネルID、Microsoft Teamsの会話ID）。デフォルトはメインセッションの最後の受信者です。
- `model` オプション（string）: モデルのオーバーライド（例: `anthropic/claude-sonnet-4-6` またはエイリアス）。制限されている場合は許可モデルリストに含まれている必要があります。
- `thinking` オプション（string）: 思考レベルのオーバーライド（例: `low`、`medium`、`high`）。
- `timeoutSeconds` オプション（number）: エージェント実行の最大時間（秒）。

効果:

- **分離された**エージェントターンを実行する（独自のセッションキー）
- 常に**メイン**セッションに要約をポストする
- `wakeMode=now` の場合、即時ハートビートをトリガーする

## セッションキーポリシー（破壊的変更）

`/hooks/agent` ペイロードの `sessionKey` オーバーライドはデフォルトで無効です。

- 推奨: 固定の `hooks.defaultSessionKey` を設定し、リクエストオーバーライドを無効のままにする。
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

### `POST /hooks/<name>`（マッピング）

カスタムフック名は `hooks.mappings` で解決されます（設定を参照）。マッピングにより、任意のペイロードを `wake` または `agent` アクションに変換でき、オプションのテンプレートやコード変換を使用できます。

マッピングオプション（概要）:

- `hooks.presets: ["gmail"]` は組み込みのGmailマッピングを有効にします。
- `hooks.mappings` で設定内に `match`、`action`、およびテンプレートを定義できます。
- `hooks.transformsDir` + `transform.module` はカスタムロジック用のJS/TSモジュールを読み込みます。
  - `hooks.transformsDir`（設定されている場合）は、OpenClaw設定ディレクトリ配下のtransformsルート内に留まる必要があります（通常 `~/.openclaw/hooks/transforms`）。
  - `transform.module` は有効なtransformsディレクトリ内で解決される必要があります（トラバーサル/エスケープパスは拒否されます）。
- `match.source` を使用して汎用的なインジェストエンドポイント（ペイロード駆動ルーティング）を維持できます。
- TS変換にはTSローダー（例: `bun` または `tsx`）、またはランタイムでプリコンパイルされた `.js` が必要です。
- マッピングに `deliver: true` + `channel`/`to` を設定すると、返信をチャットサーフェスにルーティングできます（`channel` のデフォルトは `last` で、WhatsAppにフォールバックします）。
- `agentId` はフックを特定のエージェントにルーティングします。不明なIDはデフォルトエージェントにフォールバックします。
- `hooks.allowedAgentIds` は明示的な `agentId` ルーティングを制限します。省略する（または `*` を含める）とすべてのエージェントを許可します。`[]` に設定すると明示的な `agentId` ルーティングを拒否します。
- `hooks.defaultSessionKey` は明示的なキーが提供されない場合のフックエージェント実行のデフォルトセッションを設定します。
- `hooks.allowRequestSessionKey` は `/hooks/agent` ペイロードで `sessionKey` を設定できるかどうかを制御します（デフォルト: `false`）。
- `hooks.allowedSessionKeyPrefixes` はリクエストペイロードとマッピングからの明示的な `sessionKey` 値をオプションで制限します。
- `allowUnsafeExternalContent: true` はそのフックの外部コンテンツ安全ラッパーを無効にします（危険。信頼できる内部ソースの場合のみ使用）。
- `openclaw webhooks gmail setup` は `openclaw webhooks gmail run` 用の `hooks.gmail` 設定を書き込みます。
  完全なGmail watchフローについては [Gmail Pub/Sub](/automation/gmail-pubsub) を参照してください。

## レスポンス

- `/hooks/wake` に対して `200`
- `/hooks/agent` に対して `200`（非同期実行が受理された）
- 認証失敗時に `401`
- 同一クライアントからの認証失敗が繰り返された場合に `429`（`Retry-After` を確認してください）
- 無効なペイロードの場合に `400`
- ペイロードが大きすぎる場合に `413`

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

### 別のモデルを使用する

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

- フックエンドポイントはループバック、tailnet、または信頼できるリバースプロキシの背後に配置してください。
- 専用のフックトークンを使用してください。Gateway ゲートウェイの認証トークンを再利用しないでください。
- 厳格な `tools.profile` とサンドボックス化を持つ専用のフックエージェントの使用を推奨します。これによりフックイングレスの影響範囲が狭くなります。
- 認証失敗の繰り返しは、ブルートフォース攻撃を遅延させるためにクライアントアドレスごとにレート制限されます。
- マルチエージェントルーティングを使用する場合は、`hooks.allowedAgentIds` を設定して明示的な `agentId` の選択を制限してください。
- 呼び出し元が選択するセッションが必要でない限り、`hooks.allowRequestSessionKey=false` のままにしてください。
- リクエストの `sessionKey` を有効にする場合は、`hooks.allowedSessionKeyPrefixes` を制限してください（例: `["hook:"]`）。
- Webhookログに機密性の高い生ペイロードを含めることを避けてください。
- フックペイロードは信頼されないものとして扱われ、デフォルトで安全境界でラップされます。
  特定のフックでこれを無効にする必要がある場合は、そのフックのマッピングで `allowUnsafeExternalContent: true` を設定してください（危険）。
