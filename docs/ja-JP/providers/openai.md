---
summary: "APIキーまたはCodexサブスクリプションを使ってOpenClawでOpenAIを利用する"
read_when:
  - OpenClawでOpenAIモデルを使いたい場合
  - APIキーの代わりにCodexサブスクリプション認証を使いたい場合
title: "OpenAI"
---

# OpenAI

OpenAIはGPTモデルの開発者向けAPIを提供しています。CodexはサブスクリプションアクセスのためのChatGPTサインインと、従量課金アクセスのためのAPIキーサインインをサポートしています。CodexクラウドにはアクセスにはアクセスにはアクセスにはアクセスにはアクセスにはChatGPTサインインが必要です。

## オプションA: OpenAI APIキー（OpenAIプラットフォーム）

**適した用途:** 直接APIアクセスと従量課金制。
OpenAIダッシュボードからAPIキーを取得してください。

### CLIセットアップ

```bash
openclaw onboard --auth-choice openai-api-key
# または非インタラクティブ
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### 設定スニペット

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## オプションB: OpenAI Code（Codex）サブスクリプション

**適した用途:** APIキーの代わりにChatGPT/Codexサブスクリプションアクセスを使用する。
CodexクラウドにはアクセスにはアクセスにはアクセスにはアクセスにはChatGPTサインインが必要で、Codex CLIはChatGPTまたはAPIキーサインインをサポートしています。

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
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### Codexトランスポートのデフォルト

OpenClawはモデルストリーミングに `pi-ai` を使用します。`openai-codex/*` モデルでは `agents.defaults.models.<provider/model>.params.transport` を設定してトランスポートを選択できます:

- デフォルトは `"auto"`（WebSocket優先、次にSSEフォールバック）。
- `"sse"`: SSEを強制
- `"websocket"`: WebSocketを強制
- `"auto"`: WebSocketを試み、次にSSEにフォールバック

```json5
{
  agents: {
    defaults: {
      model: { primary: "openai-codex/gpt-5.3-codex" },
      models: {
        "openai-codex/gpt-5.3-codex": {
          params: {
            transport: "auto",
          },
        },
      },
    },
  },
}
```

### OpenAI Responsesのサーバーサイドコンパクション

直接のOpenAI Responsesモデル（`api.openai.com` の `baseUrl` で `api: "openai-responses"` を使用する `openai/*`）の場合、OpenClawはOpenAIのサーバーサイドコンパクションペイロードヒントを自動的に有効にします:

- `store: true` を強制します（モデルの互換性が `supportsStore: false` を設定しない限り）
- `context_management: [{ type: "compaction", compact_threshold: ... }]` を注入します

デフォルトでは、`compact_threshold` はモデルの `contextWindow` の `70%`（利用できない場合は `80000`）です。

### サーバーサイドコンパクションを明示的に有効にする

互換性のあるResponsesモデルで `context_management` の注入を強制したい場合（例: Azure OpenAI Responses）:

```json5
{
  agents: {
    defaults: {
      models: {
        "azure-openai-responses/gpt-4o": {
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
        "openai/gpt-5": {
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
        "openai/gpt-5": {
          params: {
            responsesServerCompaction: false,
          },
        },
      },
    },
  },
}
```

`responsesServerCompaction` は `context_management` の注入のみを制御します。
直接のOpenAI Responsesモデルは互換性が `supportsStore: false` を設定しない限り引き続き `store: true` を強制します。

## 注意事項

- モデル参照は常に `provider/model` の形式を使用します（[/concepts/models](/concepts/models) を参照）。
- 認証の詳細と再利用ルールは [/concepts/oauth](/concepts/oauth) に記載されています。
