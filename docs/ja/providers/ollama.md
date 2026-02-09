---
summary: "Ollama（ローカル LLM ランタイム）で OpenClaw を実行します"
read_when:
  - Ollama を介してローカルモデルで OpenClaw を実行したい場合
  - Ollama のセットアップおよび設定ガイダンスが必要な場合
title: "Ollama"
---

# Ollama

Ollama は、オープンソースモデルを自身のマシンで簡単に実行できるローカル LLM ランタイムです。OpenClaw は Ollama の OpenAI 互換 API と統合されており、`OLLAMA_API_KEY`（または認証プロファイル）を指定してオプトインし、明示的な `models.providers.ollama` エントリーを定義しない場合、**ツール対応モデルを自動検出**できます。 OpenClawはOllamaのOpenAI対応APIと統合し、明示的な`モデルを定義しないで、`OLLAMA_API_KEY`（または認証プロファイル）を選択すると**ツール対応モデルを自動検出**することができます。 roviders.ollama`項目。

## クイックスタート

1. Ollama をインストールします: [https://ollama.ai](https://ollama.ai)

2. モデルを取得します:

```bash
ollama pull gpt-oss:20b
# or
ollama pull llama3.3
# or
ollama pull qwen2.5-coder:32b
# or
ollama pull deepseek-r1:32b
```

3. OpenClaw 用に Ollama を有効化します（任意の値で構いません。Ollama は実際のキーを必要としません）:

```bash
# Set environment variable
export OLLAMA_API_KEY="ollama-local"

# Or configure in your config file
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

4. Ollama モデルを使用します:

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

`OLLAMA_API_KEY`（または認証プロファイル）を設定し、`models.providers.ollama` を**定義しない**場合、OpenClaw は `http://127.0.0.1:11434` にあるローカル Ollama インスタンスからモデルを検出します。

- `/api/tags` と `/api/show` にクエリします
- `tools` 機能を報告するモデルのみを保持します
- モデルが `thinking` を報告した場合、`reasoning` をマークします
- 利用可能な場合、`model_info["<arch>.context_length"]` から `contextWindow` を読み取ります
- コンテキストウィンドウの 10× を `maxTokens` に設定します
- すべてのコストを `0` に設定します

これにより、Ollama の機能に合わせてカタログを整合させつつ、手動のモデルエントリーを回避できます。

利用可能なモデルを確認するには次を実行します:

```bash
ollama list
openclaw models list
```

新しいモデルを追加するには、Ollama で取得するだけです:

```bash
ollama pull mistral
```

新しいモデルは自動的に検出され、使用可能になります。

`models.providers.ollama` を明示的に設定した場合、自動検出はスキップされ、モデルを手動で定義する必要があります（以下参照）。

## 設定

### 基本セットアップ（暗黙的検出）

Ollama を有効化する最も簡単な方法は、環境変数を使用することです:

```bash
export OLLAMA_API_KEY="ollama-local"
```

### 明示的セットアップ（手動モデル）

次の場合は明示的な設定を使用します:

- Ollama が別のホスト／ポートで実行されている場合。
- 特定のコンテキストウィンドウやモデルリストを強制したい場合。
- ツールサポートを報告しないモデルを含めたい場合。

```json5
{
  models: {
    providers: {
      ollama: {
        // Use a host that includes /v1 for OpenAI-compatible APIs
        baseUrl: "http://ollama-host:11434/v1",
        apiKey: "ollama-local",
        api: "openai-completions",
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

`OLLAMA_API_KEY` が設定されている場合、プロバイダーエントリーで `apiKey` を省略でき、OpenClaw が可用性チェック用に自動補完します。

### カスタムベース URL（明示的設定）

Ollama が異なるホストまたはポートで実行されている場合（明示的設定では自動検出が無効になるため、モデルを手動で定義してください）:

```json5
{
  models: {
    providers: {
      ollama: {
        apiKey: "ollama-local",
        baseUrl: "http://ollama-host:11434/v1",
      },
    },
  },
}
```

### モデル選択

設定後、すべての Ollama モデルが利用可能になります:

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

Ollama が `/api/show` 内で `thinking` を報告した場合、OpenClaw はそのモデルを推論対応としてマークします:

```bash
ollama pull deepseek-r1:32b
```

### モデルコスト

Ollama は無料でローカル実行されるため、すべてのモデルコストは $0 に設定されます。

### ストリーミング設定

Ollama のレスポンス形式に関する基盤 SDK の [既知の問題](https://github.com/badlogic/pi-mono/issues/1205) により、**Ollama モデルではストリーミングはデフォルトで無効**になっています。これにより、ツール対応モデル使用時の破損したレスポンスを防止します。 これにより、ツール対応モデルの使用時に破損した応答を防ぎます。

ストリーミングが無効な場合、レスポンスは一括で配信され（非ストリーミングモード）、コンテンツ／推論のデルタが混在して出力が崩れる問題を回避できます。

#### ストリーミングの再有効化（高度）

Ollama でストリーミングを再有効化したい場合（ツール対応モデルで問題が発生する可能性があります）:

```json5
{
  agents: {
    defaults: {
      models: {
        "ollama/gpt-oss:20b": {
          streaming: true,
        },
      },
    },
  },
}
```

#### 他のプロバイダーでストリーミングを無効化

必要に応じて、任意のプロバイダーでストリーミングを無効化することもできます:

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-4": {
          streaming: false,
        },
      },
    },
  },
}
```

### コンテキストウィンドウ

自動検出されたモデルについては、OpenClaw は利用可能な場合に Ollama が報告するコンテキストウィンドウを使用し、そうでない場合は `8192` を既定値として使用します。明示的なプロバイダー設定では、`contextWindow` および `maxTokens` を上書きできます。 明示的なプロバイダ設定で `contextWindow` と `maxTokens` を上書きできます。

## トラブルシューティング

### Ollama が検出されない

Ollama が実行中であること、`OLLAMA_API_KEY`（または認証プロファイル）を設定していること、そして明示的な `models.providers.ollama` エントリーを**定義していない**ことを確認してください。

```bash
ollama serve
```

また、API にアクセス可能であることを確認してください:

```bash
curl http://localhost:11434/api/tags
```

### 利用可能なモデルがない

OpenClaw は、ツールサポートを報告するモデルのみを自動検出します。モデルが一覧に表示されない場合は、次のいずれかを行ってください: モデルがリストされていない場合は、次のいずれかを実行します。

- ツール対応モデルを取得する、または
- `models.providers.ollama` にモデルを明示的に定義する。

モデルを追加するには:

```bash
ollama list  # See what's installed
ollama pull gpt-oss:20b  # Pull a tool-capable model
ollama pull llama3.3     # Or another model
```

### 接続が拒否される

Ollama が正しいポートで実行されていることを確認してください:

```bash
# Check if Ollama is running
ps aux | grep ollama

# Or restart Ollama
ollama serve
```

### レスポンスの破損や出力内のツール名

Ollama モデル使用時に、`sessions_send`、`memory_get` のようなツール名を含む文字化けしたレスポンスや断片化されたテキストが表示される場合、これはストリーミングレスポンスに関する上流 SDK の問題が原因です。最新の OpenClaw バージョンでは、Ollama モデルのストリーミングを無効化することで**既定で修正**されています。 \*\*これはOllamaモデルのストリーミングを無効にすることにより、最新のOpenClawバージョンでデフォルトで修正されています。

ストリーミングを手動で有効化してこの問題が発生した場合は、次のいずれかを行ってください:

1. Ollama のモデルエントリーから `streaming: true` 設定を削除する、または
2. Ollama モデルに対して `streaming: false` を明示的に設定する（[ストリーミング設定](#ストリーミング-configuration) を参照）

## See Also

- [Model Providers](/concepts/model-providers) - すべてのプロバイダーの概要
- [Model Selection](/concepts/models) - モデルの選び方
- [Configuration](/gateway/configuration) - 設定の完全なリファレンス
