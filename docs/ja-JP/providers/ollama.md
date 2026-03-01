---
summary: "OpenClawをOllama（ローカルLLMランタイム）で実行する"
read_when:
  - Ollamaを使ってローカルモデルでOpenClawを実行したい場合
  - Ollamaのセットアップと設定ガイダンスが必要な場合
title: "Ollama"
---

# Ollama

Ollamaはローカルのオープンソースモデルを簡単に実行できるローカルLLMランタイムです。OpenClawはOllamaのネイティブAPI（`/api/chat`）と統合し、ストリーミングとツール呼び出しをサポートしています。また、`OLLAMA_API_KEY`（または認証プロファイル）をオプトインし、`models.providers.ollama` エントリを明示的に定義しない場合、**ツール対応モデルを自動検出**できます。

<Warning>
**リモートOllamaユーザーへ**: OpenClawでは `/v1` のOpenAI互換URL（`http://host:11434/v1`）を使用しないでください。これはツール呼び出しを壊し、モデルが生のツールJSONをプレーンテキストとして出力する場合があります。代わりにネイティブOllama APIのURLを使用してください: `baseUrl: "http://host:11434"`（`/v1` なし）。
</Warning>

## クイックスタート

1. Ollamaをインストールする: [https://ollama.ai](https://ollama.ai)

2. モデルをプルする:

```bash
ollama pull gpt-oss:20b
# または
ollama pull llama3.3
# または
ollama pull qwen2.5-coder:32b
# または
ollama pull deepseek-r1:32b
```

3. OpenClaw用にOllamaを有効にする（任意の値でOK。Ollamaは実際のキーを必要としません）:

```bash
# 環境変数を設定する
export OLLAMA_API_KEY="ollama-local"

# または設定ファイルで設定する
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

4. Ollamaモデルを使用する:

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/gpt-oss:20b" },
    },
  },
}
```

## モデル検出（暗黙的プロバイダー）

`OLLAMA_API_KEY`（または認証プロファイル）を設定して、`models.providers.ollama` を**定義しない**場合、OpenClawは `http://127.0.0.1:11434` のローカルOllamaインスタンスからモデルを検出します:

- `/api/tags` と `/api/show` をクエリ
- `tools` 機能を報告するモデルのみを保持
- モデルが `thinking` を報告した場合に `reasoning` をマーク
- 利用可能な場合は `model_info["<arch>.context_length"]` から `contextWindow` を読み取り
- `maxTokens` をコンテキストウィンドウの10倍に設定
- すべてのコストを `0` に設定

これにより、Ollamaの機能に合わせたカタログを維持しながら、手動でモデルエントリを追加する手間が省けます。

利用可能なモデルを確認するには:

```bash
ollama list
openclaw models list
```

新しいモデルを追加するには、Ollamaでプルするだけです:

```bash
ollama pull mistral
```

新しいモデルは自動的に検出されて使用可能になります。

`models.providers.ollama` を明示的に設定すると、自動検出はスキップされ、モデルを手動で定義する必要があります（以下を参照）。

## 設定

### 基本セットアップ（暗黙的検出）

Ollamaを有効にする最も簡単な方法は環境変数を使用することです:

```bash
export OLLAMA_API_KEY="ollama-local"
```

### 明示的セットアップ（手動モデル）

以下の場合に明示的な設定を使用します:

- Ollamaが別のホスト/ポートで動作している。
- 特定のコンテキストウィンドウやモデルリストを強制したい。
- ツールサポートを報告しないモデルを含めたい。

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434",
        apiKey: "ollama-local",
        api: "ollama",
        models: [
          {
            id: "gpt-oss:20b",
            name: "GPT-OSS 20B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 8192 * 10
          }
        ]
      }
    }
  }
}
```

`OLLAMA_API_KEY` が設定されている場合、プロバイダーエントリで `apiKey` を省略でき、OpenClawは可用性チェックのために自動的に設定します。

### カスタムベースURL（明示的設定）

Ollamaが別のホストやポートで動作している場合（明示的な設定は自動検出を無効にするため、モデルを手動で定義してください）:

```json5
{
  models: {
    providers: {
      ollama: {
        apiKey: "ollama-local",
        baseUrl: "http://ollama-host:11434", // /v1 なし - ネイティブOllama API URLを使用
        api: "ollama", // ネイティブツール呼び出し動作を保証するために明示的に設定
      },
    },
  },
}
```

<Warning>
URLに `/v1` を追加しないでください。`/v1` パスはOpenAI互換モードを使用し、ツール呼び出しの信頼性が低下します。パスサフィックスなしのベースOllama URLを使用してください。
</Warning>

### モデル選択

設定後、すべてのOllamaモデルが利用可能になります:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "ollama/gpt-oss:20b",
        fallbacks: ["ollama/llama3.3", "ollama/qwen2.5-coder:32b"],
      },
    },
  },
}
```

## 高度な設定

### 推論モデル

Ollamaが `/api/show` で `thinking` を報告した場合、OpenClawはモデルを推論対応としてマークします:

```bash
ollama pull deepseek-r1:32b
```

### モデルコスト

Ollamaは無料でローカルで実行されるため、すべてのモデルコストは$0に設定されています。

### ストリーミング設定

OpenClawのOllama統合は、デフォルトで**ネイティブOllama API**（`/api/chat`）を使用しており、ストリーミングとツール呼び出しを同時に完全サポートしています。特別な設定は不要です。

#### レガシーOpenAI互換モード

<Warning>
**OpenAI互換モードではツール呼び出しの信頼性が低下します。** OpenAI形式を必要とするプロキシが必要で、かつネイティブツール呼び出し動作に依存しない場合のみ、このモードを使用してください。
</Warning>

OpenAI互換エンドポイントを使用する必要がある場合（例: OpenAI形式のみをサポートするプロキシの背後）、`api: "openai-completions"` を明示的に設定してください:

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434/v1",
        api: "openai-completions",
        injectNumCtxForOpenAICompat: true, // デフォルト: true
        apiKey: "ollama-local",
        models: [...]
      }
    }
  }
}
```

このモードではストリーミングとツール呼び出しを同時にサポートできない場合があります。モデル設定で `params: { streaming: false }` を使ってストリーミングを無効にする必要があるかもしれません。

OllamaでOpenAI互換モード（`api: "openai-completions"`）を使用する場合、OpenClawはデフォルトで `options.num_ctx` を注入し、Ollamaが静かに4096コンテキストウィンドウにフォールバックしないようにします。プロキシ/アップストリームが未知の `options` フィールドを拒否する場合は、この動作を無効にしてください:

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434/v1",
        api: "openai-completions",
        injectNumCtxForOpenAICompat: false,
        apiKey: "ollama-local",
        models: [...]
      }
    }
  }
}
```

### コンテキストウィンドウ

自動検出されたモデルでは、OpenClawはOllamaが報告するコンテキストウィンドウを利用可能な場合に使用し、それ以外の場合は `8192` がデフォルトになります。明示的なプロバイダー設定で `contextWindow` と `maxTokens` をオーバーライドできます。

## トラブルシューティング

### Ollamaが検出されない

Ollamaが実行中であること、`OLLAMA_API_KEY`（または認証プロファイル）が設定されていること、そして明示的な `models.providers.ollama` エントリを**定義していない**ことを確認してください:

```bash
ollama serve
```

また、APIにアクセス可能であることも確認してください:

```bash
curl http://localhost:11434/api/tags
```

### モデルが利用できない

OpenClawはツールサポートを報告するモデルのみを自動検出します。モデルがリストされていない場合は:

- ツール対応モデルをプルする、または
- `models.providers.ollama` でモデルを明示的に定義する

モデルを追加するには:

```bash
ollama list  # インストール済みのものを確認
ollama pull gpt-oss:20b  # ツール対応モデルをプルする
ollama pull llama3.3     # または別のモデル
```

### 接続が拒否された

Ollamaが正しいポートで実行されているか確認してください:

```bash
# Ollamaが実行中か確認する
ps aux | grep ollama

# またはOllamaを再起動する
ollama serve
```

## 関連情報

- [モデルプロバイダー](/concepts/model-providers) - すべてのプロバイダーの概要
- [モデル選択](/concepts/models) - モデルの選択方法
- [設定](/gateway/configuration) - 完全な設定リファレンス
