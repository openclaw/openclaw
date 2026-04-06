---
read_when:
    - Ollamaを使用してクラウドまたはローカルモデルでOpenClawを実行したい場合
    - Ollamaのセットアップと設定のガイダンスが必要な場合
summary: OpenClawをOllama（クラウドおよびローカルモデル）で実行する
title: Ollama
x-i18n:
    generated_at: "2026-04-02T08:59:11Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 89e441e7e987baa3568e4d274a99b43b40024cefb88e5667e39205fd2d99aefe
    source_path: providers/ollama.md
    workflow: 15
---

# Ollama

Ollamaは、オープンソースモデルをマシン上で簡単に実行できるローカルLLMランタイムです。OpenClawはOllamaのネイティブAPI（`/api/chat`）と統合し、ストリーミングとツール呼び出しをサポートし、`OLLAMA_API_KEY`（または認証プロファイル）を設定して明示的な`models.providers.ollama`エントリを定義しない場合、ローカルのOllamaモデルを自動検出できます。

<Warning>
**リモートOllamaユーザーへ**: OpenClawで`/v1` OpenAI互換URL（`http://host:11434/v1`）を使用しないでください。これによりツール呼び出しが壊れ、モデルが生のツールJSONをプレーンテキストとして出力する場合があります。代わりにネイティブOllama API URLを使用してください: `baseUrl: "http://host:11434"`（`/v1`なし）。
</Warning>

## クイックスタート

### オンボーディング（推奨）

Ollamaをセットアップする最速の方法はオンボーディングです:

```bash
openclaw onboard
```

プロバイダーリストから**Ollama**を選択します。オンボーディングでは以下が行われます:

1. インスタンスに到達できるOllamaベースURLを尋ねます（デフォルト`http://127.0.0.1:11434`）。
2. **Cloud + Local**（クラウドモデルとローカルモデル）または**Local**（ローカルモデルのみ）を選択できます。
3. **Cloud + Local**を選択してollama.comにサインインしていない場合、ブラウザでサインインフローが開きます。
4. 利用可能なモデルを検出し、デフォルトを提案します。
5. 選択したモデルがローカルで利用できない場合、自動的にプルします。

非対話モードもサポートされています:

```bash
openclaw onboard --non-interactive \
  --auth-choice ollama \
  --accept-risk
```

オプションでカスタムベースURLやモデルを指定できます:

```bash
openclaw onboard --non-interactive \
  --auth-choice ollama \
  --custom-base-url "http://ollama-host:11434" \
  --custom-model-id "qwen3.5:27b" \
  --accept-risk
```

### 手動セットアップ

1. Ollamaをインストール: [https://ollama.com/download](https://ollama.com/download)

2. ローカル推論を行う場合はローカルモデルをプルします:

```bash
ollama pull glm-4.7-flash
# または
ollama pull gpt-oss:20b
# または
ollama pull llama3.3
```

3. クラウドモデルも使用する場合はサインインします:

```bash
ollama signin
```

4. オンボーディングを実行し、`Ollama`を選択します:

```bash
openclaw onboard
```

- `Local`: ローカルモデルのみ
- `Cloud + Local`: ローカルモデルとクラウドモデル
- `kimi-k2.5:cloud`、`minimax-m2.5:cloud`、`glm-5:cloud`などのクラウドモデルはローカルの`ollama pull`が**不要**です

OpenClawは現在以下を提案します:

- ローカルデフォルト: `glm-4.7-flash`
- クラウドデフォルト: `kimi-k2.5:cloud`、`minimax-m2.5:cloud`、`glm-5:cloud`

5. 手動セットアップを希望する場合は、OpenClawでOllamaを直接有効にします（任意の値で動作します。Ollamaは実際のキーを必要としません）:

```bash
# 環境変数を設定
export OLLAMA_API_KEY="ollama-local"

# または設定ファイルで設定
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

6. モデルの確認または切り替え:

```bash
openclaw models list
openclaw models set ollama/glm-4.7-flash
```

7. または設定でデフォルトを指定:

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/glm-4.7-flash" },
    },
  },
}
```

## モデル検出（暗黙的プロバイダー）

`OLLAMA_API_KEY`（または認証プロファイル）を設定し、`models.providers.ollama`を**定義しない**場合、OpenClawは`http://127.0.0.1:11434`のローカルOllamaインスタンスからモデルを検出します:

- `/api/tags`をクエリします
- 利用可能な場合、`/api/show`のベストエフォートルックアップを使用して`contextWindow`を読み取ります
- モデル名のヒューリスティック（`r1`、`reasoning`、`think`）で`reasoning`をマークします
- `maxTokens`をOpenClawが使用するデフォルトのOllama最大トークン上限に設定します
- すべてのコストを`0`に設定します

これにより、手動のモデルエントリを避けながら、カタログをローカルOllamaインスタンスと整合させます。

利用可能なモデルを確認するには:

```bash
ollama list
openclaw models list
```

新しいモデルを追加するには、Ollamaでプルするだけです:

```bash
ollama pull mistral
```

新しいモデルは自動的に検出され、使用可能になります。

`models.providers.ollama`を明示的に設定した場合、自動検出はスキップされ、モデルを手動で定義する必要があります（以下を参照）。

## 設定

### 基本セットアップ（暗黙的検出）

Ollamaを有効にする最も簡単な方法は環境変数です:

```bash
export OLLAMA_API_KEY="ollama-local"
```

### 明示的セットアップ（手動モデル）

以下の場合は明示的な設定を使用します:

- Ollamaが別のホスト/ポートで実行されている場合。
- 特定のコンテキストウィンドウやモデルリストを強制したい場合。
- 完全に手動でモデルを定義したい場合。

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

`OLLAMA_API_KEY`が設定されている場合、プロバイダーエントリの`apiKey`を省略でき、OpenClawが可用性チェック用に補完します。

### カスタムベースURL（明示的設定）

Ollamaが別のホストまたはポートで実行されている場合（明示的設定は自動検出を無効にするため、モデルを手動で定義してください）:

```json5
{
  models: {
    providers: {
      ollama: {
        apiKey: "ollama-local",
        baseUrl: "http://ollama-host:11434", // /v1なし - ネイティブOllama API URLを使用
        api: "ollama", // ネイティブのツール呼び出し動作を保証するために明示的に設定
      },
    },
  },
}
```

<Warning>
URLに`/v1`を追加しないでください。`/v1`パスはOpenAI互換モードを使用し、ツール呼び出しが信頼できません。パスサフィックスなしのベースOllama URLを使用してください。
</Warning>

### モデル選択

設定が完了すると、すべてのOllamaモデルが利用可能になります:

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

## クラウドモデル

クラウドモデルを使用すると、クラウドホストされたモデル（例: `kimi-k2.5:cloud`、`minimax-m2.5:cloud`、`glm-5:cloud`）をローカルモデルと並行して実行できます。

クラウドモデルを使用するには、セットアップ時に**Cloud + Local**モードを選択します。ウィザードはサインイン済みかどうかを確認し、必要に応じてブラウザでサインインフローを開きます。認証を確認できない場合、ウィザードはローカルモデルのデフォルトにフォールバックします。

[ollama.com/signin](https://ollama.com/signin)で直接サインインすることもできます。

## 詳細設定

### 推論モデル

OpenClawは、`deepseek-r1`、`reasoning`、`think`などの名前を持つモデルをデフォルトで推論対応として扱います:

```bash
ollama pull deepseek-r1:32b
```

### モデルコスト

Ollamaは無料でローカル実行されるため、すべてのモデルコストは$0に設定されています。

### ストリーミング設定

OpenClawのOllama統合はデフォルトで**ネイティブOllama API**（`/api/chat`）を使用し、ストリーミングとツール呼び出しを同時に完全サポートします。特別な設定は不要です。

#### レガシーOpenAI互換モード

<Warning>
**OpenAI互換モードではツール呼び出しが信頼できません。**このモードは、プロキシ用にOpenAIフォーマットが必要で、ネイティブのツール呼び出し動作に依存しない場合にのみ使用してください。
</Warning>

代わりにOpenAI互換エンドポイントを使用する必要がある場合（例: OpenAIフォーマットのみをサポートするプロキシの背後にある場合）、`api: "openai-completions"`を明示的に設定します:

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

このモードではストリーミングとツール呼び出しを同時にサポートできない場合があります。モデル設定で`params: { streaming: false }`を使用してストリーミングを無効にする必要がある場合があります。

`api: "openai-completions"`をOllamaで使用する場合、OpenClawはデフォルトで`options.num_ctx`を注入し、Ollamaが4096コンテキストウィンドウに暗黙的にフォールバックするのを防ぎます。プロキシ/アップストリームが不明な`options`フィールドを拒否する場合、この動作を無効にします:

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

自動検出されたモデルの場合、OpenClawは利用可能であればOllamaが報告するコンテキストウィンドウを使用し、それ以外の場合はOpenClawが使用するデフォルトのOllamaコンテキストウィンドウにフォールバックします。明示的なプロバイダー設定で`contextWindow`と`maxTokens`を上書きできます。

## トラブルシューティング

### Ollamaが検出されない

Ollamaが実行中であること、`OLLAMA_API_KEY`（または認証プロファイル）が設定されていること、明示的な`models.providers.ollama`エントリを定義して**いない**ことを確認してください:

```bash
ollama serve
```

また、APIにアクセスできることを確認してください:

```bash
curl http://localhost:11434/api/tags
```

### モデルが利用できない

モデルが一覧に表示されない場合は、以下のいずれかを行ってください:

- モデルをローカルにプルする
- `models.providers.ollama`でモデルを明示的に定義する

モデルを追加するには:

```bash
ollama list  # インストール済みのモデルを確認
ollama pull glm-4.7-flash
ollama pull gpt-oss:20b
ollama pull llama3.3     # または別のモデル
```

### 接続拒否

Ollamaが正しいポートで実行されているか確認してください:

```bash
# Ollamaが実行中か確認
ps aux | grep ollama

# またはOllamaを再起動
ollama serve
```

## 関連項目

- [モデルプロバイダー](/concepts/model-providers) - すべてのプロバイダーの概要
- [モデル選択](/concepts/models) - モデルの選び方
- [設定](/gateway/configuration) - 設定の完全なリファレンス
