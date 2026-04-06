---
read_when:
    - OpenAI Chat Completions を期待するツールを統合する場合
summary: Gateway ゲートウェイから OpenAI 互換の /v1/chat/completions HTTP エンドポイントを公開する
title: OpenAI Chat Completions
x-i18n:
    generated_at: "2026-04-02T08:31:20Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 571cbc9b1c23e2aa4aa40211b6ef72ec7c8fd158b3f45715e8733c388c9e8145
    source_path: gateway/openai-http-api.md
    workflow: 15
---

# OpenAI Chat Completions (HTTP)

OpenClaw の Gateway ゲートウェイは、小規模な OpenAI 互換 Chat Completions エンドポイントを提供できます。

このエンドポイントは**デフォルトで無効**です。まず設定で有効にしてください。

- `POST /v1/chat/completions`
- Gateway ゲートウェイと同じポート（WS + HTTP 多重化）: `http://<gateway-host>:<port>/v1/chat/completions`

Gateway ゲートウェイの OpenAI 互換 HTTP サーフェスが有効な場合、以下も提供されます:

- `GET /v1/models`
- `GET /v1/models/{id}`
- `POST /v1/embeddings`
- `POST /v1/responses`

内部的には、リクエストは通常の Gateway ゲートウェイのエージェント実行（`openclaw agent` と同じコードパス）として処理されるため、ルーティング/権限/設定は Gateway ゲートウェイの設定と一致します。

## 認証

Gateway ゲートウェイの認証設定を使用します。ベアラートークンを送信してください:

- `Authorization: Bearer <token>`

注意事項:

- `gateway.auth.mode="token"` の場合、`gateway.auth.token`（または `OPENCLAW_GATEWAY_TOKEN`）を使用します。
- `gateway.auth.mode="password"` の場合、`gateway.auth.password`（または `OPENCLAW_GATEWAY_PASSWORD`）を使用します。
- `gateway.auth.rateLimit` が設定されていて認証失敗が多すぎる場合、エンドポイントは `Retry-After` 付きの `429` を返します。

## セキュリティ境界（重要）

このエンドポイントは Gateway ゲートウェイインスタンスの**フルオペレーターアクセス**サーフェスとして扱ってください。

- ここでの HTTP ベアラー認証は、狭い範囲のユーザーごとのスコープモデルではありません。
- このエンドポイント用の有効な Gateway ゲートウェイトークン/パスワードは、オーナー/オペレーターの認証情報と同等に扱うべきです。
- リクエストは、信頼されたオペレーター操作と同じコントロールプレーンのエージェントパスを通じて実行されます。
- このエンドポイントには個別の非オーナー/ユーザーごとのツール境界はありません。呼び出し元がここで Gateway ゲートウェイ認証を通過すると、OpenClaw はその呼び出し元をこの Gateway ゲートウェイの信頼されたオペレーターとして扱います。
- 共有シークレット認証モード（`token` および `password`）の場合、呼び出し元がより狭い `x-openclaw-scopes` ヘッダーを送信しても、エンドポイントは通常のフルオペレーターデフォルトを復元します。
- 信頼された ID ベースの HTTP モード（例: 信頼されたプロキシ認証や `gateway.auth.mode="none"`）は、リクエストで宣言されたオペレータースコープを尊重します。
- ターゲットエージェントのポリシーがセンシティブなツールを許可している場合、このエンドポイントはそれらを使用できます。
- このエンドポイントはループバック/tailnet/プライベートイングレスのみに限定してください。パブリックインターネットに直接公開しないでください。

認証マトリクス:

- `gateway.auth.mode="token"` または `"password"` + `Authorization: Bearer ...`
  - 共有 Gateway ゲートウェイオペレーターシークレットの所有を証明します
  - より狭い `x-openclaw-scopes` は無視されます
  - フルデフォルトオペレータースコープセットが復元されます
  - このエンドポイントでのチャットターンはオーナー送信者ターンとして扱われます
- 信頼された ID ベースの HTTP モード（例: 信頼されたプロキシ認証、またはプライベートイングレスでの `gateway.auth.mode="none"`）
  - 外部の信頼された ID またはデプロイメント境界を認証します
  - 宣言された `x-openclaw-scopes` ヘッダーを尊重します
  - 宣言されたスコープに `operator.admin` が実際に含まれている場合のみオーナーセマンティクスが適用されます

[セキュリティ](/gateway/security)および[リモートアクセス](/gateway/remote)を参照してください。

## エージェントファーストモデル契約

OpenClaw は OpenAI の `model` フィールドを生のプロバイダーモデル ID ではなく、**エージェントターゲット**として扱います。

- `model: "openclaw"` は設定済みのデフォルトエージェントにルーティングされます。
- `model: "openclaw/default"` もデフォルトエージェントにルーティングされます。
- `model: "openclaw/<agentId>"` は特定のエージェントにルーティングされます。

オプションのリクエストヘッダー:

- `x-openclaw-model: <provider/model-or-bare-id>` は選択されたエージェントのバックエンドモデルをオーバーライドします。
- `x-openclaw-agent-id: <agentId>` は互換性オーバーライドとして引き続きサポートされています。
- `x-openclaw-session-key: <sessionKey>` はセッションルーティングを完全に制御します。
- `x-openclaw-message-channel: <channel>` はチャネル対応プロンプトおよびポリシー向けの合成イングレスチャネルコンテキストを設定します。

互換性エイリアスも引き続き使用可能:

- `model: "openclaw:<agentId>"`
- `model: "agent:<agentId>"`

## エンドポイントの有効化

`gateway.http.endpoints.chatCompletions.enabled` を `true` に設定します:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

## エンドポイントの無効化

`gateway.http.endpoints.chatCompletions.enabled` を `false` に設定します:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: false },
      },
    },
  },
}
```

## セッションの動作

デフォルトでは、エンドポイントは**リクエストごとにステートレス**です（呼び出しごとに新しいセッションキーが生成されます）。

リクエストに OpenAI の `user` 文字列が含まれている場合、Gateway ゲートウェイはそこから安定したセッションキーを導出し、繰り返しの呼び出しでエージェントセッションを共有できます。

## このサーフェスが重要な理由

これはセルフホスト型フロントエンドやツール向けに最も活用度の高い互換性セットです:

- ほとんどの Open WebUI、LobeChat、LibreChat のセットアップは `/v1/models` を期待します。
- 多くの RAG システムは `/v1/embeddings` を期待します。
- 既存の OpenAI チャットクライアントは通常 `/v1/chat/completions` から始められます。
- よりエージェントネイティブなクライアントは `/v1/responses` を好む傾向が増えています。

## モデル一覧とエージェントルーティング

<AccordionGroup>
  <Accordion title="`/v1/models` は何を返しますか？">
    OpenClaw エージェントターゲットのリストです。

    返される ID は `openclaw`、`openclaw/default`、および `openclaw/<agentId>` エントリです。
    これらを OpenAI の `model` 値として直接使用してください。

  </Accordion>
  <Accordion title="`/v1/models` はエージェントとサブエージェントのどちらを一覧表示しますか？">
    トップレベルのエージェントターゲットを一覧表示します。バックエンドのプロバイダーモデルやサブエージェントは含まれません。

    サブエージェントは内部の実行トポロジーのままです。疑似モデルとしては表示されません。

  </Accordion>
  <Accordion title="なぜ `openclaw/default` が含まれているのですか？">
    `openclaw/default` は設定済みのデフォルトエージェントの安定したエイリアスです。

    これにより、環境間で実際のデフォルトエージェント ID が変わっても、クライアントは1つの予測可能な ID を使い続けることができます。

  </Accordion>
  <Accordion title="バックエンドモデルをオーバーライドするにはどうすればよいですか？">
    `x-openclaw-model` を使用します。

    例:
    `x-openclaw-model: openai/gpt-5.4`
    `x-openclaw-model: gpt-5.4`

    省略した場合、選択されたエージェントは通常設定されたモデルで実行されます。

  </Accordion>
  <Accordion title="エンベディングはこの契約にどう適合しますか？">
    `/v1/embeddings` は同じエージェントターゲットの `model` ID を使用します。

    `model: "openclaw/default"` または `model: "openclaw/<agentId>"` を使用してください。
    特定のエンベディングモデルが必要な場合は、`x-openclaw-model` で送信してください。
    このヘッダーがない場合、リクエストは選択されたエージェントの通常のエンベディング設定に渡されます。

  </Accordion>
</AccordionGroup>

## ストリーミング (SSE)

`stream: true` を設定すると Server-Sent Events (SSE) を受信できます:

- `Content-Type: text/event-stream`
- 各イベント行は `data: <json>`
- ストリームは `data: [DONE]` で終了します

## Open WebUI クイックセットアップ

基本的な Open WebUI 接続の場合:

- ベース URL: `http://127.0.0.1:18789/v1`
- macOS での Docker ベース URL: `http://host.docker.internal:18789/v1`
- API キー: Gateway ゲートウェイのベアラートークン
- モデル: `openclaw/default`

期待される動作:

- `GET /v1/models` は `openclaw/default` を一覧表示するはずです
- Open WebUI は `openclaw/default` をチャットモデル ID として使用するはずです
- そのエージェントに特定のバックエンドプロバイダー/モデルを使用したい場合は、エージェントの通常のデフォルトモデルを設定するか、`x-openclaw-model` を送信してください

クイック確認:

```bash
curl -sS http://127.0.0.1:18789/v1/models \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

これが `openclaw/default` を返せば、ほとんどの Open WebUI セットアップは同じベース URL とトークンで接続できます。

## 使用例

非ストリーミング:

```bash
curl -sS http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "openclaw/default",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

ストリーミング:

```bash
curl -N http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-model: openai/gpt-5.4' \
  -d '{
    "model": "openclaw/research",
    "stream": true,
    "messages": [{"role":"user","content":"hi"}]
  }'
```

モデル一覧:

```bash
curl -sS http://127.0.0.1:18789/v1/models \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

単一モデルの取得:

```bash
curl -sS http://127.0.0.1:18789/v1/models/openclaw%2Fdefault \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

エンベディングの作成:

```bash
curl -sS http://127.0.0.1:18789/v1/embeddings \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-model: openai/text-embedding-3-small' \
  -d '{
    "model": "openclaw/default",
    "input": ["alpha", "beta"]
  }'
```

注意事項:

- `/v1/models` は生のプロバイダーカタログではなく、OpenClaw エージェントターゲットを返します。
- `openclaw/default` は常に存在するため、環境をまたいで1つの安定した ID が使えます。
- バックエンドのプロバイダー/モデルのオーバーライドは OpenAI の `model` フィールドではなく、`x-openclaw-model` に指定してください。
- `/v1/embeddings` は `input` として文字列または文字列の配列をサポートします。
