---
read_when:
    - OpenClawでOpenAIモデルを使いたい
    - APIキーの代わりにCodexサブスクリプション認証を使いたい
summary: OpenClawでAPIキーまたはCodexサブスクリプション経由でOpenAIを使用する
title: OpenAI
x-i18n:
    generated_at: "2026-04-02T08:59:08Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 9d664da8443f78c1b0ea773ca5759b102f881fe000e9d9c23e864dc90c811485
    source_path: providers/openai.md
    workflow: 15
---

# OpenAI

OpenAIはGPTモデル向けの開発者APIを提供している。Codexはサブスクリプションアクセス用の**ChatGPTサインイン**、または従量課金アクセス用の**APIキー**サインインをサポートしている。Codexクラウドの利用にはChatGPTサインインが必要である。
OpenAIはOpenClawのような外部ツール／ワークフローでのサブスクリプションOAuth使用を明示的にサポートしている。

## オプションA: OpenAI APIキー（OpenAI Platform）

**最適な用途:** 直接APIアクセスと従量課金。
OpenAIダッシュボードからAPIキーを取得する。

### CLIセットアップ

```bash
openclaw onboard --auth-choice openai-api-key
# または非対話型
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### 設定スニペット

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
}
```

OpenAIの現在のAPIモデルドキュメントでは、直接OpenAI API使用向けに`gpt-5.4`と`gpt-5.4-pro`が記載されている。OpenClawは両方を`openai/*` Responsesパス経由で転送する。
OpenClawは古い`openai/gpt-5.3-codex-spark`行を意図的に抑制している。これはライブトラフィックで直接OpenAI API呼び出しが拒否されるためである。

OpenClawは直接OpenAI APIパスで`openai/gpt-5.3-codex-spark`を公開**しない**。`pi-ai`はそのモデル用の組み込み行を提供しているが、現在ライブOpenAI APIリクエストは拒否される。SparkはOpenClawではCodex専用として扱われる。

## オプションB: OpenAI Code（Codex）サブスクリプション

**最適な用途:** APIキーの代わりにChatGPT/Codexサブスクリプションアクセスを使用する。
Codexクラウドの利用にはChatGPTサインインが必要であり、Codex CLIはChatGPTまたはAPIキーサインインをサポートしている。

### CLIセットアップ（Codex OAuth）

```bash
# ウィザードでCodex OAuthを実行する
openclaw onboard --auth-choice openai-codex

# またはOAuthを直接実行する
openclaw models auth login --provider openai-codex
```

### 設定スニペット（Codexサブスクリプション）

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
}
```

OpenAIの現在のCodexドキュメントでは`gpt-5.4`が現行のCodexモデルとして記載されている。OpenClawはこれをChatGPT/Codex OAuth使用向けに`openai-codex/gpt-5.4`にマッピングする。

CodexアカウントがCodex Sparkの利用資格を持っている場合、OpenClawは以下もサポートする：

- `openai-codex/gpt-5.3-codex-spark`

OpenClawはCodex SparkをCodex専用として扱う。直接的な`openai/gpt-5.3-codex-spark`のAPIキーパスは公開しない。

OpenClawは`pi-ai`が検出した`openai-codex/gpt-5.3-codex-spark`も保持する。これは利用資格依存かつ実験的なものとして扱うこと：Codex SparkはGPT-5.4の`/fast`とは別物であり、利用可能性はサインインしたCodex/ChatGPTアカウントに依存する。

### トランスポートのデフォルト

OpenClawはモデルストリーミングに`pi-ai`を使用する。`openai/*`と`openai-codex/*`の両方で、デフォルトトランスポートは`"auto"`（WebSocket優先、SSEフォールバック）である。

`agents.defaults.models.<provider/model>.params.transport`で設定できる：

- `"sse"`: SSEを強制する
- `"websocket"`: WebSocketを強制する
- `"auto"`: WebSocketを試行し、SSEにフォールバックする

`openai/*`（Responses API）の場合、OpenClawはWebSocketトランスポート使用時にデフォルトでWebSocketウォームアップも有効にする（`openaiWsWarmup: true`）。

関連するOpenAIドキュメント：

- [Realtime API with WebSocket](https://platform.openai.com/docs/guides/realtime-websocket)
- [Streaming API responses (SSE)](https://platform.openai.com/docs/guides/streaming-responses)

```json5
{
  agents: {
    defaults: {
      model: { primary: "openai-codex/gpt-5.4" },
      models: {
        "openai-codex/gpt-5.4": {
          params: {
            transport: "auto",
          },
        },
      },
    },
  },
}
```

### OpenAI WebSocketウォームアップ

OpenAIのドキュメントではウォームアップはオプションとされている。OpenClawはWebSocketトランスポート使用時の初回ターンレイテンシを低減するため、`openai/*`ではデフォルトで有効にしている。

### ウォームアップを無効にする

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            openaiWsWarmup: false,
          },
        },
      },
    },
  },
}
```

### ウォームアップを明示的に有効にする

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            openaiWsWarmup: true,
          },
        },
      },
    },
  },
}
```

### OpenAIとCodexの優先処理

OpenAIのAPIは`service_tier=priority`で優先処理を公開している。OpenClawでは`agents.defaults.models["<provider>/<model>"].params.serviceTier`を設定することで、ネイティブOpenAI/Codex Responsesエンドポイントにそのフィールドを渡すことができる。

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            serviceTier: "priority",
          },
        },
        "openai-codex/gpt-5.4": {
          params: {
            serviceTier: "priority",
          },
        },
      },
    },
  },
}
```

サポートされる値は`auto`、`default`、`flex`、`priority`である。

OpenClawは、これらのモデルがネイティブOpenAI/Codexエンドポイントを指している場合、直接`openai/*` Responsesリクエストと`openai-codex/*` Codex Responsesリクエストの両方に`params.serviceTier`を転送する。

重要な動作：

- 直接`openai/*`は`api.openai.com`をターゲットにする必要がある
- `openai-codex/*`は`chatgpt.com/backend-api`をターゲットにする必要がある
- いずれかのプロバイダーを別のベースURLやプロキシ経由でルーティングする場合、OpenClawは`service_tier`をそのまま維持する

### OpenAI高速モード

OpenClawは`openai/*`と`openai-codex/*`のセッション両方で共有の高速モードトグルを公開している：

- チャット/UI: `/fast status|on|off`
- 設定: `agents.defaults.models["<provider>/<model>"].params.fastMode`

高速モードが有効な場合、OpenClawはOpenAIの優先処理にマッピングする：

- `api.openai.com`への直接`openai/*` Responses呼び出しは`service_tier = "priority"`を送信する
- `chatgpt.com/backend-api`への`openai-codex/*` Responses呼び出しも`service_tier = "priority"`を送信する
- 既存のペイロード`service_tier`値は保持される
- 高速モードは`reasoning`や`text.verbosity`を書き換えない

例：

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            fastMode: true,
          },
        },
        "openai-codex/gpt-5.4": {
          params: {
            fastMode: true,
          },
        },
      },
    },
  },
}
```

セッションのオーバーライドは設定より優先される。セッションUIでセッションオーバーライドをクリアすると、セッションは設定されたデフォルトに戻る。

### OpenAI Responsesサーバーサイドコンパクション

直接OpenAI Responsesモデル（`api.openai.com`の`baseUrl`で`api: "openai-responses"`を使用する`openai/*`）の場合、OpenClawはOpenAIサーバーサイドコンパクションのペイロードヒントを自動有効化する：

- `store: true`を強制する（モデル互換性が`supportsStore: false`を設定している場合を除く）
- `context_management: [{ type: "compaction", compact_threshold: ... }]`を注入する

デフォルトでは、`compact_threshold`はモデルの`contextWindow`の`70%`（利用できない場合は`80000`）である。

### サーバーサイドコンパクションを明示的に有効にする

互換性のあるResponsesモデル（例：Azure OpenAI Responses）で`context_management`の注入を強制したい場合に使用する：

```json5
{
  agents: {
    defaults: {
      models: {
        "azure-openai-responses/gpt-5.4": {
          params: {
            responsesServerCompaction: true,
          },
        },
      },
    },
  },
}
```

### カスタム閾値で有効にする

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            responsesServerCompaction: true,
            responsesCompactThreshold: 120000,
          },
        },
      },
    },
  },
}
```

### サーバーサイドコンパクションを無効にする

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            responsesServerCompaction: false,
          },
        },
      },
    },
  },
}
```

`responsesServerCompaction`は`context_management`の注入のみを制御する。直接OpenAI Responsesモデルは、互換性が`supportsStore: false`を設定しない限り、引き続き`store: true`を強制する。

## 注意事項

- モデル参照は常に`provider/model`の形式を使用する（[/concepts/models](/concepts/models)を参照）。
- 認証の詳細と再利用ルールについては[/concepts/oauth](/concepts/oauth)を参照。
