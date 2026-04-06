---
read_when:
    - OpenClawでプライバシー重視の推論を利用したい場合
    - Venice AIのセットアップ手順を知りたい場合
summary: Venice AIのプライバシー重視モデルをOpenClawで使用する
title: Venice AI
x-i18n:
    generated_at: "2026-04-02T07:51:58Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 53313e45e197880feb7e90764ee8fd6bb7f5fd4fe03af46b594201c77fbc8eab
    source_path: providers/venice.md
    workflow: 15
---

# Venice AI（Venice ハイライト）

**Venice**は、プライバシーファーストの推論と、プロプライエタリモデルへのオプションの匿名化アクセスを提供するハイライトVeniceセットアップです。

Venice AIはプライバシー重視のAI推論を提供し、検閲なしのモデルと匿名プロキシを介した主要プロプライエタリモデルへのアクセスをサポートしています。すべての推論はデフォルトでプライベートであり、データのトレーニングへの利用やログ記録は行われません。

## OpenClawでVeniceを使う理由

- オープンソースモデルの**プライベート推論**（ログ記録なし）。
- 必要な時に**検閲なしのモデル**を利用可能。
- 品質が重要な場合にプロプライエタリモデル（Opus/GPT/Gemini）への**匿名化アクセス**。
- OpenAI互換の`/v1`エンドポイント。

## プライバシーモード

Veniceは2つのプライバシーレベルを提供しています。モデル選択の鍵となるため理解が重要です：

| モード | 説明 | モデル |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **プライベート** | 完全にプライベート。プロンプト/レスポンスは**保存もログ記録もされません**。一時的。 | Llama、Qwen、DeepSeek、Kimi、MiniMax、Venice Uncensored等 |
| **匿名化** | Veniceを介してプロキシされ、メタデータが除去されます。基盤プロバイダー（OpenAI、Anthropic、Google、xAI）には匿名化されたリクエストが送信されます。 | Claude、GPT、Gemini、Grok |

## 機能

- **プライバシー重視**: 「プライベート」（完全にプライベート）と「匿名化」（プロキシ経由）モードから選択可能
- **検閲なしのモデル**: コンテンツ制限のないモデルにアクセス可能
- **主要モデルへのアクセス**: Veniceの匿名プロキシ経由でClaude、GPT、Gemini、Grokを利用
- **OpenAI互換API**: 簡単に統合できる標準の`/v1`エンドポイント
- **ストリーミング**: ✅ すべてのモデルでサポート
- **関数呼び出し**: ✅ 一部のモデルでサポート（モデルの機能を確認してください）
- **ビジョン**: ✅ ビジョン機能を持つモデルでサポート
- **厳格なレート制限なし**: 極端な使用量の場合、フェアユーススロットリングが適用される場合があります

## セットアップ

### 1. APIキーの取得

1. [venice.ai](https://venice.ai)でサインアップ
2. **Settings → API Keys → Create new key**に移動
3. APIキーをコピー（形式: `vapi_xxxxxxxxxxxx`）

### 2. OpenClawの設定

**オプションA: 環境変数**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**オプションB: インタラクティブセットアップ（推奨）**

```bash
openclaw onboard --auth-choice venice-api-key
```

この操作で以下が行われます：

1. APIキーの入力を求めます（または既存の`VENICE_API_KEY`を使用）
2. 利用可能なすべてのVeniceモデルを表示
3. デフォルトモデルを選択可能
4. プロバイダーを自動設定

**オプションC: 非インタラクティブ**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. セットアップの確認

```bash
openclaw agent --model venice/kimi-k2-5 --message "Hello, are you working?"
```

## モデルの選択

セットアップ後、OpenClawは利用可能なすべてのVeniceモデルを表示します。ニーズに応じて選択してください：

- **デフォルトモデル**: `venice/kimi-k2-5` — 優れたプライベート推論とビジョン機能。
- **高機能オプション**: `venice/claude-opus-4-6` — 最も強力な匿名化Veniceパス。
- **プライバシー**: 完全にプライベートな推論には「プライベート」モデルを選択。
- **機能性**: Veniceのプロキシ経由でClaude、GPT、Geminiにアクセスするには「匿名化」モデルを選択。

デフォルトモデルはいつでも変更可能です：

```bash
openclaw models set venice/kimi-k2-5
openclaw models set venice/claude-opus-4-6
```

利用可能なすべてのモデルを一覧表示：

```bash
openclaw models list | grep venice
```

## `openclaw configure`による設定

1. `openclaw configure`を実行
2. **Model/auth**を選択
3. **Venice AI**を選択

## どのモデルを使うべきか

| ユースケース | 推奨モデル | 理由 |
| -------------------------- | -------------------------------- | -------------------------------------------- |
| **一般的なチャット（デフォルト）** | `kimi-k2-5` | 優れたプライベート推論とビジョン |
| **最高の総合品質** | `claude-opus-4-6` | 最も強力な匿名化Veniceオプション |
| **プライバシー + コーディング** | `qwen3-coder-480b-a35b-instruct` | 大きなコンテキストを持つプライベートコーディングモデル |
| **プライベートビジョン** | `kimi-k2-5` | プライベートモードを離れずにビジョンをサポート |
| **高速 + 低コスト** | `qwen3-4b` | 軽量な推論モデル |
| **複雑なプライベートタスク** | `deepseek-v3.2` | 優れた推論、ただしVeniceツールサポートなし |
| **検閲なし** | `venice-uncensored` | コンテンツ制限なし |

## 利用可能なモデル（全41種）

### プライベートモデル（26種）- 完全にプライベート、ログ記録なし

| モデルID | 名前 | コンテキスト | 機能 |
| -------------------------------------- | ----------------------------------- | ------- | -------------------------- |
| `kimi-k2-5` | Kimi K2.5 | 256k | デフォルト、推論、ビジョン |
| `kimi-k2-thinking` | Kimi K2 Thinking | 256k | 推論 |
| `llama-3.3-70b` | Llama 3.3 70B | 128k | 汎用 |
| `llama-3.2-3b` | Llama 3.2 3B | 128k | 汎用 |
| `hermes-3-llama-3.1-405b` | Hermes 3 Llama 3.1 405B | 128k | 汎用、ツール無効 |
| `qwen3-235b-a22b-thinking-2507` | Qwen3 235B Thinking | 128k | 推論 |
| `qwen3-235b-a22b-instruct-2507` | Qwen3 235B Instruct | 128k | 汎用 |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B | 256k | コーディング |
| `qwen3-coder-480b-a35b-instruct-turbo` | Qwen3 Coder 480B Turbo | 256k | コーディング |
| `qwen3-5-35b-a3b` | Qwen3.5 35B A3B | 256k | 推論、ビジョン |
| `qwen3-next-80b` | Qwen3 Next 80B | 256k | 汎用 |
| `qwen3-vl-235b-a22b` | Qwen3 VL 235B（ビジョン） | 256k | ビジョン |
| `qwen3-4b` | Venice Small（Qwen3 4B） | 32k | 高速、推論 |
| `deepseek-v3.2` | DeepSeek V3.2 | 160k | 推論、ツール無効 |
| `venice-uncensored` | Venice Uncensored（Dolphin-Mistral） | 32k | 検閲なし、ツール無効 |
| `mistral-31-24b` | Venice Medium（Mistral） | 128k | ビジョン |
| `google-gemma-3-27b-it` | Google Gemma 3 27B Instruct | 198k | ビジョン |
| `openai-gpt-oss-120b` | OpenAI GPT OSS 120B | 128k | 汎用 |
| `nvidia-nemotron-3-nano-30b-a3b` | NVIDIA Nemotron 3 Nano 30B | 128k | 汎用 |
| `olafangensan-glm-4.7-flash-heretic` | GLM 4.7 Flash Heretic | 128k | 推論 |
| `zai-org-glm-4.6` | GLM 4.6 | 198k | 汎用 |
| `zai-org-glm-4.7` | GLM 4.7 | 198k | 推論 |
| `zai-org-glm-4.7-flash` | GLM 4.7 Flash | 128k | 推論 |
| `zai-org-glm-5` | GLM 5 | 198k | 推論 |
| `minimax-m21` | MiniMax M2.1 | 198k | 推論 |
| `minimax-m25` | MiniMax M2.5 | 198k | 推論 |

### 匿名化モデル（15種）- Veniceプロキシ経由

| モデルID | 名前 | コンテキスト | 機能 |
| ------------------------------- | ------------------------------ | ------- | ------------------------- |
| `claude-opus-4-6` | Claude Opus 4.6（Venice経由） | 1M | 推論、ビジョン |
| `claude-opus-4-5` | Claude Opus 4.5（Venice経由） | 198k | 推論、ビジョン |
| `claude-sonnet-4-6` | Claude Sonnet 4.6（Venice経由） | 1M | 推論、ビジョン |
| `claude-sonnet-4-5` | Claude Sonnet 4.5（Venice経由） | 198k | 推論、ビジョン |
| `openai-gpt-54` | GPT-5.4（Venice経由） | 1M | 推論、ビジョン |
| `openai-gpt-53-codex` | GPT-5.3 Codex（Venice経由） | 400k | 推論、ビジョン、コーディング |
| `openai-gpt-52` | GPT-5.2（Venice経由） | 256k | 推論 |
| `openai-gpt-52-codex` | GPT-5.2 Codex（Venice経由） | 256k | 推論、ビジョン、コーディング |
| `openai-gpt-4o-2024-11-20` | GPT-4o（Venice経由） | 128k | ビジョン |
| `openai-gpt-4o-mini-2024-07-18` | GPT-4o Mini（Venice経由） | 128k | ビジョン |
| `gemini-3-1-pro-preview` | Gemini 3.1 Pro（Venice経由） | 1M | 推論、ビジョン |
| `gemini-3-pro-preview` | Gemini 3 Pro（Venice経由） | 198k | 推論、ビジョン |
| `gemini-3-flash-preview` | Gemini 3 Flash（Venice経由） | 256k | 推論、ビジョン |
| `grok-41-fast` | Grok 4.1 Fast（Venice経由） | 1M | 推論、ビジョン |
| `grok-code-fast-1` | Grok Code Fast 1（Venice経由） | 256k | 推論、コーディング |

## モデルディスカバリー

OpenClawは`VENICE_API_KEY`が設定されている場合、Venice APIからモデルを自動的に検出します。APIに到達できない場合は、静的カタログにフォールバックします。

`/models`エンドポイントは公開されており（一覧取得に認証は不要）、推論には有効なAPIキーが必要です。

## ストリーミングとツールサポート

| 機能 | サポート状況 |
| -------------------- | ------------------------------------------------------- |
| **ストリーミング** | ✅ すべてのモデル |
| **関数呼び出し** | ✅ ほとんどのモデル（APIの`supportsFunctionCalling`を確認） |
| **ビジョン/画像** | ✅ 「ビジョン」機能を持つモデル |
| **JSONモード** | ✅ `response_format`経由でサポート |

## 料金

Veniceはクレジットベースのシステムを使用しています。現在の料金は[venice.ai/pricing](https://venice.ai/pricing)を確認してください：

- **プライベートモデル**: 一般的に低コスト
- **匿名化モデル**: 直接APIの料金 + 少額のVenice手数料と同程度

## 比較: Venice vs 直接API

| 項目 | Venice（匿名化） | 直接API |
| ------------ | ----------------------------- | ------------------- |
| **プライバシー** | メタデータ除去、匿名化 | アカウントに紐付け |
| **レイテンシ** | +10-50ms（プロキシ） | 直接接続 |
| **機能** | ほとんどの機能をサポート | すべての機能 |
| **課金** | Veniceクレジット | プロバイダー課金 |

## 使用例

```bash
# デフォルトのプライベートモデルを使用
openclaw agent --model venice/kimi-k2-5 --message "Quick health check"

# Venice経由でClaude Opusを使用（匿名化）
openclaw agent --model venice/claude-opus-4-6 --message "Summarize this task"

# 検閲なしモデルを使用
openclaw agent --model venice/venice-uncensored --message "Draft options"

# ビジョンモデルを画像と共に使用
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

キーが`vapi_`で始まっていることを確認してください。

### モデルが利用できない

Veniceのモデルカタログは動的に更新されます。`openclaw models list`を実行して現在利用可能なモデルを確認してください。一部のモデルは一時的にオフラインになっている場合があります。

### 接続の問題

Venice APIは`https://api.venice.ai/api/v1`にあります。ネットワークがHTTPS接続を許可していることを確認してください。

## 設定ファイルの例

```json5
{
  env: { VENICE_API_KEY: "vapi_..." },
  agents: { defaults: { model: { primary: "venice/kimi-k2-5" } } },
  models: {
    mode: "merge",
    providers: {
      venice: {
        baseUrl: "https://api.venice.ai/api/v1",
        apiKey: "${VENICE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "kimi-k2-5",
            name: "Kimi K2.5",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 65536,
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
