---
read_when:
    - キャッシュ保持によりプロンプトトークンコストを削減したい場合
    - マルチエージェント構成でエージェントごとのキャッシュ動作が必要な場合
    - ハートビートと cache-ttl プルーニングを組み合わせてチューニングしている場合
summary: プロンプトキャッシュの設定、マージ順序、プロバイダーの動作、チューニングパターン
title: プロンプトキャッシュ
x-i18n:
    generated_at: "2026-04-02T07:51:59Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: b8ec6f0da29e7dd1f04c25c58840c909cf333c5e4546ee2c3b8287fec783ca32
    source_path: reference/prompt-caching.md
    workflow: 15
---

# プロンプトキャッシュ

プロンプトキャッシュとは、モデルプロバイダーが変更されていないプロンプトプレフィックス（通常はシステム/開発者の指示やその他の安定したコンテキスト）を毎回再処理する代わりに、ターン間で再利用できることを意味します。最初のマッチするリクエストがキャッシュトークンを書き込み（`cacheWrite`）、以降のマッチするリクエストでそれを読み戻すことができます（`cacheRead`）。

これが重要な理由: トークンコストの削減、レスポンスの高速化、長時間セッションでのより予測可能なパフォーマンス。キャッシュがない場合、入力のほとんどが変更されていなくても、繰り返されるプロンプトは毎ターン全額のプロンプトコストを支払うことになります。

このページでは、プロンプトの再利用とトークンコストに影響するすべてのキャッシュ関連の設定について説明します。

Anthropic の料金詳細については、以下を参照してください:
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

## 主要な設定

### `cacheRetention`（グローバルデフォルト、モデル、エージェントごと）

すべてのモデルに対するグローバルデフォルトとしてキャッシュ保持を設定します:

```yaml
agents:
  defaults:
    params:
      cacheRetention: "long" # none | short | long
```

モデルごとにオーバーライド:

```yaml
agents:
  defaults:
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "short" # none | short | long
```

エージェントごとのオーバーライド:

```yaml
agents:
  list:
    - id: "alerts"
      params:
        cacheRetention: "none"
```

設定のマージ順序:

1. `agents.defaults.params`（グローバルデフォルト — すべてのモデルに適用）
2. `agents.defaults.models["provider/model"].params`（モデルごとのオーバーライド）
3. `agents.list[].params`（一致するエージェント ID; キーごとにオーバーライド）

### レガシー `cacheControlTtl`

レガシー値は引き続き受け付けられ、マッピングされます:

- `5m` -> `short`
- `1h` -> `long`

新しい設定では `cacheRetention` を使用してください。

### `contextPruning.mode: "cache-ttl"`

キャッシュ TTL ウィンドウの経過後に古いツール結果のコンテキストをプルーニングし、アイドル後のリクエストが過大な履歴を再キャッシュしないようにします。

```yaml
agents:
  defaults:
    contextPruning:
      mode: "cache-ttl"
      ttl: "1h"
```

完全な動作については[セッションプルーニング](/concepts/session-pruning)を参照してください。

### ハートビートによるキープウォーム

ハートビートはキャッシュウィンドウをウォーム状態に保ち、アイドル後の繰り返しキャッシュ書き込みを削減できます。

```yaml
agents:
  defaults:
    heartbeat:
      every: "55m"
```

エージェントごとのハートビートは `agents.list[].heartbeat` でサポートされています。

## プロバイダーの動作

### Anthropic（直接 API）

- `cacheRetention` がサポートされています。
- Anthropic APIキー認証プロファイルでは、未設定の場合、OpenClaw は Anthropic モデル参照に対して `cacheRetention: "short"` をシードします。

### Amazon Bedrock

- Anthropic Claude モデル参照（`amazon-bedrock/*anthropic.claude*`）は、明示的な `cacheRetention` のパススルーをサポートしています。
- 非 Anthropic Bedrock モデルは、ランタイムで `cacheRetention: "none"` に強制されます。

### OpenRouter Anthropic モデル

`openrouter/anthropic/*` モデル参照の場合、OpenClaw はシステム/開発者プロンプトブロックに Anthropic の `cache_control` を注入し、プロンプトキャッシュの再利用を改善します。

### その他のプロバイダー

プロバイダーがこのキャッシュモードをサポートしていない場合、`cacheRetention` は効果がありません。

## チューニングパターン

### 混合トラフィック（推奨デフォルト）

メインエージェントに長期間のベースラインを維持し、バースト的な通知エージェントではキャッシュを無効にします:

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
  list:
    - id: "research"
      default: true
      heartbeat:
        every: "55m"
    - id: "alerts"
      params:
        cacheRetention: "none"
```

### コスト優先ベースライン

- ベースラインの `cacheRetention: "short"` を設定します。
- `contextPruning.mode: "cache-ttl"` を有効にします。
- ウォームキャッシュの恩恵を受けるエージェントのみ、TTL 以下のハートビートを維持します。

## キャッシュ診断

OpenClaw は組み込みエージェント実行用に専用のキャッシュトレース診断を公開しています。

### `diagnostics.cacheTrace` 設定

```yaml
diagnostics:
  cacheTrace:
    enabled: true
    filePath: "~/.openclaw/logs/cache-trace.jsonl" # optional
    includeMessages: false # default true
    includePrompt: false # default true
    includeSystem: false # default true
```

デフォルト値:

- `filePath`: `$OPENCLAW_STATE_DIR/logs/cache-trace.jsonl`
- `includeMessages`: `true`
- `includePrompt`: `true`
- `includeSystem`: `true`

### 環境変数トグル（一時的なデバッグ用）

- `OPENCLAW_CACHE_TRACE=1` でキャッシュトレースを有効にします。
- `OPENCLAW_CACHE_TRACE_FILE=/path/to/cache-trace.jsonl` で出力パスをオーバーライドします。
- `OPENCLAW_CACHE_TRACE_MESSAGES=0|1` で完全なメッセージペイロードのキャプチャを切り替えます。
- `OPENCLAW_CACHE_TRACE_PROMPT=0|1` でプロンプトテキストのキャプチャを切り替えます。
- `OPENCLAW_CACHE_TRACE_SYSTEM=0|1` でシステムプロンプトのキャプチャを切り替えます。

### 確認すべきポイント

- キャッシュトレースイベントは JSONL 形式で、`session:loaded`、`prompt:before`、`stream:context`、`session:after` などのステージスナップショットが含まれます。
- ターンごとのキャッシュトークンの影響は、`cacheRead` と `cacheWrite` を通じて通常の使用画面で確認できます（例: `/usage full` やセッション使用量サマリー）。

## クイックトラブルシューティング

- ほとんどのターンで `cacheWrite` が高い場合: 変動しやすいシステムプロンプト入力を確認し、モデル/プロバイダーがキャッシュ設定をサポートしていることを確認してください。
- `cacheRetention` が効果がない場合: モデルキーが `agents.defaults.models["provider/model"]` と一致していることを確認してください。
- キャッシュ設定を含む Bedrock Nova/Mistral リクエスト: ランタイムで `none` に強制されるのは想定どおりの動作です。

関連ドキュメント:

- [Anthropic](/providers/anthropic)
- [トークン使用量とコスト](/reference/token-use)
- [セッションプルーニング](/concepts/session-pruning)
- [Gateway ゲートウェイ設定リファレンス](/gateway/configuration-reference)
