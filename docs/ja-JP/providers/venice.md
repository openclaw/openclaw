---
summary: "Venice AIのプライバシー重視モデルをOpenClawで使用する"
read_when:
  - OpenClawでプライバシー重視の推論を使いたい場合
  - Venice AIのセットアップガイダンスが必要な場合
title: "Venice AI"
---

# Venice AI（Veniceハイライト）

**Venice**は、プライバシーを最優先とした推論と、プロプライエタリモデルへの匿名化されたアクセスオプションを提供する、推奨のVeniceセットアップです。

Venice AIは、無検閲モデルのサポートと主要なプロプライエタリモデルへの匿名化プロキシアクセスを備えたプライバシー重視のAI推論を提供しています。すべての推論はデフォルトでプライベートです。データのトレーニングやログ記録は行われません。

## OpenClawでVeniceを使う理由

- オープンソースモデルの**プライベート推論**（ログなし）。
- 必要な場合の**無検閲モデル**。
- 品質が重要な場合のプロプライエタリモデル（Opus/GPT/Gemini）への**匿名化アクセス**。
- OpenAI互換の `/v1` エンドポイント。

## プライバシーモード

Veniceは2つのプライバシーレベルを提供しています。モデルを選択する際に理解しておく重要な点です:

| モード           | 説明                                                                                                                 | モデル                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **プライベート**    | 完全にプライベート。プロンプト/レスポンスは**保存またはログに記録されません**。エフェメラル。                                        | Llama、Qwen、DeepSeek、Venice Uncensored など |
| **匿名化**     | メタデータが削除されてVenice経由でプロキシされます。基盤となるプロバイダー（OpenAI、Anthropic）は匿名化されたリクエストを受け取ります。 | Claude、GPT、Gemini、Grok、Kimi、MiniMax       |

## 機能

- **プライバシー重視**: 「プライベート」（完全プライベート）と「匿名化」（プロキシ）モードを選択可能
- **無検閲モデル**: コンテンツ制限のないモデルへのアクセス
- **主要モデルアクセス**: Veniceの匿名化プロキシ経由でClaude、GPT-5.2、Gemini、Grokを使用
- **OpenAI互換API**: 簡単な統合のための標準 `/v1` エンドポイント
- **ストリーミング**: すべてのモデルでサポート
- **関数呼び出し**: 一部のモデルでサポート（モデル機能を確認してください）
- **ビジョン**: ビジョン機能を持つモデルでサポート
- **ハードなレートリミットなし**: 極端な使用に対してフェアユース制限が適用される場合あり

## セットアップ

### 1. APIキーを取得する

1. [venice.ai](https://venice.ai) でサインアップ
2. **設定 → APIキー → 新しいキーを作成** に移動
3. APIキーをコピー（形式: `vapi_xxxxxxxxxxxx`）

### 2. OpenClawを設定する

**オプションA: 環境変数**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**オプションB: インタラクティブセットアップ（推奨）**

```bash
openclaw onboard --auth-choice venice-api-key
```

これにより以下が実行されます:

1. APIキーを求めるプロンプト（または既存の `VENICE_API_KEY` を使用）
2. 利用可能なすべてのVeniceモデルを表示
3. デフォルトモデルを選択
4. プロバイダーを自動設定

**オプションC: 非インタラクティブ**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. セットアップを確認する

```bash
openclaw agent --model venice/llama-3.3-70b --message "Hello, are you working?"
```

## モデル選択

セットアップ後、OpenClawは利用可能なすべてのVeniceモデルを表示します。ニーズに応じて選択してください:

- **デフォルト（推奨）**: `venice/llama-3.3-70b` プライベートでバランスの良いパフォーマンス。
- **最高品質**: `venice/claude-opus-45` 難しいタスク向け（Opusは依然として最も強力）。
- **プライバシー**: 完全なプライベート推論のために「プライベート」モデルを選択。
- **機能性**: VeniceのプロキシでClaude、GPT、Geminiにアクセスするために「匿名化」モデルを選択。

デフォルトモデルをいつでも変更できます:

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

利用可能なすべてのモデルを一覧表示:

```bash
openclaw models list | grep venice
```

## `openclaw configure` で設定する

1. `openclaw configure` を実行
2. **Model/auth** を選択
3. **Venice AI** を選択

## どのモデルを使うべきか

| ユースケース                     | 推奨モデル                        | 理由                                       |
| ---------------------------- | -------------------------------- | ----------------------------------------- |
| **一般的なチャット**             | `llama-3.3-70b`                  | 汎用性が高く完全にプライベート            |
| **最高品質**                   | `claude-opus-45`                 | Opusは依然として難しいタスクに最も強力    |
| **プライバシー + Claude品質**    | `claude-opus-45`                 | 匿名化プロキシ経由の最高の推論能力        |
| **コーディング**                 | `qwen3-coder-480b-a35b-instruct` | コード最適化、262kコンテキスト            |
| **ビジョンタスク**               | `qwen3-vl-235b-a22b`             | 最高のプライベートビジョンモデル          |
| **無検閲**                     | `venice-uncensored`              | コンテンツ制限なし                        |
| **高速かつ低コスト**             | `qwen3-4b`                       | 軽量ながら能力あり                        |
| **複雑な推論**                  | `deepseek-v3.2`                  | 強力な推論能力、プライベート              |

## 利用可能なモデル（25モデル）

### プライベートモデル（15）— 完全プライベート、ログなし

| モデルID                         | 名前                    | コンテキスト（トークン） | 機能                    |
| -------------------------------- | ----------------------- | ---------------- | ----------------------- |
| `llama-3.3-70b`                  | Llama 3.3 70B           | 131k             | 汎用                    |
| `llama-3.2-3b`                   | Llama 3.2 3B            | 131k             | 高速、軽量              |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B | 131k             | 複雑なタスク            |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking     | 131k             | 推論                    |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct     | 131k             | 汎用                    |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B        | 262k             | コード                  |
| `qwen3-next-80b`                 | Qwen3 Next 80B          | 262k             | 汎用                    |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B           | 262k             | ビジョン                |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k              | 高速、推論              |
| `deepseek-v3.2`                  | DeepSeek V3.2           | 163k             | 推論                    |
| `venice-uncensored`              | Venice Uncensored       | 32k              | 無検閲                  |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k             | ビジョン                |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct    | 202k             | ビジョン                |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B     | 131k             | 汎用                    |
| `zai-org-glm-4.7`                | GLM 4.7                 | 202k             | 推論、多言語            |

### 匿名化モデル（10）— Veniceプロキシ経由

| モデルID                 | オリジナル          | コンテキスト（トークン） | 機能              |
| ------------------------ | ----------------- | ---------------- | ----------------- |
| `claude-opus-45`         | Claude Opus 4.5   | 202k             | 推論、ビジョン    |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k             | 推論、ビジョン    |
| `openai-gpt-52`          | GPT-5.2           | 262k             | 推論              |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k             | 推論、ビジョン    |
| `gemini-3-pro-preview`   | Gemini 3 Pro      | 202k             | 推論、ビジョン    |
| `gemini-3-flash-preview` | Gemini 3 Flash    | 262k             | 推論、ビジョン    |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k             | 推論、ビジョン    |
| `grok-code-fast-1`       | Grok Code Fast 1  | 262k             | 推論、コード      |
| `kimi-k2-thinking`       | Kimi K2 Thinking  | 262k             | 推論              |
| `minimax-m21`            | MiniMax M2.1      | 202k             | 推論              |

## モデル検出

`VENICE_API_KEY` が設定されている場合、OpenClawはVenice APIからモデルを自動的に検出します。APIに接続できない場合は静的なカタログにフォールバックします。

`/models` エンドポイントは公開されています（一覧取得に認証不要ですが、推論には有効なAPIキーが必要です）。

## ストリーミングとツールのサポート

| 機能                   | サポート                                                 |
| -------------------- | ------------------------------------------------------- |
| **ストリーミング**        | すべてのモデルでサポート                                  |
| **関数呼び出し**         | ほとんどのモデルでサポート（APIの `supportsFunctionCalling` を確認） |
| **ビジョン/画像**        | 「ビジョン」機能でマークされたモデル                      |
| **JSONモード**          | `response_format` 経由でサポート                         |

## 料金

Veniceはクレジットベースのシステムを使用しています。現在のレートは [venice.ai/pricing](https://venice.ai/pricing) を確認してください:

- **プライベートモデル**: 一般的に低コスト
- **匿名化モデル**: 直接API料金 + 小さなVenice手数料に近い

## 比較: Venice vs 直接API

| 側面          | Venice（匿名化）               | 直接API             |
| ------------ | ----------------------------- | ------------------- |
| **プライバシー**  | メタデータ削除、匿名化          | アカウントにリンク   |
| **レイテンシー** | +10-50ms（プロキシ）           | 直接                |
| **機能**       | ほとんどの機能をサポート        | フル機能             |
| **請求**       | Veniceクレジット               | プロバイダー請求     |

## 使用例

```bash
# デフォルトのプライベートモデルを使用
openclaw agent --model venice/llama-3.3-70b --message "Quick health check"

# Venice経由でClaudeを使用（匿名化）
openclaw agent --model venice/claude-opus-45 --message "Summarize this task"

# 無検閲モデルを使用
openclaw agent --model venice/venice-uncensored --message "Draft options"

# 画像でビジョンモデルを使用
openclaw agent --model venice/qwen3-vl-235b-a22b --message "Review attached image"

# コーディングモデルを使用
openclaw agent --model venice/qwen3-coder-480b-a35b-instruct --message "Refactor this function"
```

## トラブルシューティング

### APIキーが認識されない

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

キーが `vapi_` で始まることを確認してください。

### モデルが利用できない

Veniceのモデルカタログは動的に更新されます。`openclaw models list` を実行して現在利用可能なモデルを確認してください。一部のモデルは一時的にオフラインになる場合があります。

### 接続の問題

Venice APIは `https://api.venice.ai/api/v1` にあります。ネットワークがHTTPS接続を許可していることを確認してください。

## 設定ファイルの例

```json5
{
  env: { VENICE_API_KEY: "vapi_..." },
  agents: { defaults: { model: { primary: "venice/llama-3.3-70b" } } },
  models: {
    mode: "merge",
    providers: {
      venice: {
        baseUrl: "https://api.venice.ai/api/v1",
        apiKey: "${VENICE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.3-70b",
            name: "Llama 3.3 70B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## リンク

- [Venice AI](https://venice.ai)
- [APIドキュメント](https://docs.venice.ai)
- [料金](https://venice.ai/pricing)
- [ステータス](https://status.venice.ai)
