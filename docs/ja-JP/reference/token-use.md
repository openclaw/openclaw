---
summary: "OpenClaw がプロンプトコンテキストを構築し、トークン使用量とコストを報告する方法"
read_when:
  - トークンの使用量、コスト、またはコンテキストウィンドウを説明するとき
  - コンテキストの増加やコンパクションの動作をデバッグするとき
title: "トークンの使用とコスト"
---

# トークンの使用とコスト

OpenClaw は文字ではなく**トークン**を追跡します。トークンはモデル固有ですが、ほとんどの OpenAI スタイルのモデルは英語テキストでトークンあたり約 4 文字が平均です。

## システムプロンプトの構築方法

OpenClaw は実行ごとに独自のシステムプロンプトを組み立てます。これには以下が含まれます:

- ツールリスト + 短い説明
- スキルリスト（メタデータのみ。指示は `read` でオンデマンドに読み込まれます）
- セルフアップデートの指示
- ワークスペース + ブートストラップファイル（`AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`、新規の場合 `BOOTSTRAP.md`、存在する場合は `MEMORY.md` および/または `memory.md`）。大きなファイルは `agents.defaults.bootstrapMaxChars`（デフォルト: 20000）で切り詰められ、合計ブートストラップインジェクションは `agents.defaults.bootstrapTotalMaxChars`（デフォルト: 150000）で制限されます。`memory/*.md` ファイルはメモリツール経由のオンデマンドであり、自動的にインジェクトされません。
- 時刻（UTC + ユーザータイムゾーン）
- 返信タグ + ハートビートの動作
- ランタイムメタデータ（ホスト/OS/モデル/思考）

完全な詳細は [システムプロンプト](/concepts/system-prompt) を参照してください。

## コンテキストウィンドウでカウントされるもの

モデルが受け取るすべてのものがコンテキスト制限にカウントされます:

- システムプロンプト（上記のすべてのセクション）
- 会話履歴（ユーザー + アシスタントのメッセージ）
- ツール呼び出しとツール結果
- 添付ファイル/トランスクリプト（画像、音声、ファイル）
- コンパクションサマリーとプルーニング成果物
- プロバイダーラッパーまたは安全ヘッダー（表示されませんが、カウントされます）

画像については、OpenClaw はプロバイダー呼び出し前にトランスクリプト/ツールの画像ペイロードをダウンスケールします。
これを調整するには `agents.defaults.imageMaxDimensionPx`（デフォルト: `1200`）を使用してください:

- 低い値は通常、ビジョントークンの使用量とペイロードサイズを削減します。
- 高い値は OCR/UI 重視のスクリーンショットのために視覚的な詳細を保持します。

インジェクトされたファイル、ツール、スキル、およびシステムプロンプトサイズごとの実用的な内訳については、`/context list` または `/context detail` を使用してください。[コンテキスト](/concepts/context) を参照してください。

## 現在のトークン使用量を確認する方法

チャットで次を使用してください:

- `/status` → セッションモデル、コンテキスト使用量、最後のレスポンスの入出力トークン、および**推定コスト**（API キーのみ）を含む**絵文字豊富なステータスカード**。
- `/usage off|tokens|full` → すべての返信に**レスポンスごとの使用フッター**を追加します。
  - セッションごとに永続します（`responseUsage` として保存）。
  - OAuth 認証はコストを**非表示**にします（トークンのみ）。
- `/usage cost` → OpenClaw セッションログからローカルコストサマリーを表示します。

その他のサーフェス:

- **TUI/Web TUI:** `/status` + `/usage` がサポートされています。
- **CLI:** `openclaw status --usage` と `openclaw channels list` はプロバイダーのクォータウィンドウを表示します（レスポンスごとのコストではありません）。

## コスト推定（表示される場合）

コストはモデルの価格設定設定から推定されます:

```
models.providers.<provider>.models[].cost
```

これらは `input`、`output`、`cacheRead`、`cacheWrite` に対して **1M トークンあたりの USD** です。価格設定が欠落している場合、OpenClaw はトークンのみを表示します。OAuth トークンはドルコストを表示しません。

## キャッシュ TTL とプルーニングの影響

プロバイダーのプロンプトキャッシングはキャッシュ TTL ウィンドウ内でのみ適用されます。OpenClaw はオプションで**キャッシュ TTL プルーニング**を実行できます: キャッシュ TTL が期限切れになった後にセッションをプルーニングし、キャッシュウィンドウをリセットして、その後のリクエストが完全な履歴を再キャッシングする代わりに、新しくキャッシュされたコンテキストを再利用できるようにします。これにより、セッションが TTL を超えてアイドル状態になったときのキャッシュ書き込みコストを低く保ちます。

[Gateway 設定](/gateway/configuration) で設定し、[セッションプルーニング](/concepts/session-pruning) で動作の詳細を確認してください。

ハートビートはアイドルギャップ全体でキャッシュを**ウォーム**に保てます。モデルのキャッシュ TTL が `1h` の場合、ハートビート間隔をそれよりわずかに短く設定する（例: `55m`）と、完全なプロンプトの再キャッシングを避けてキャッシュ書き込みコストを削減できます。

マルチエージェントのセットアップでは、1 つの共有モデル設定を保持し、`agents.list[].params.cacheRetention` でエージェントごとにキャッシュ動作を調整できます。

ノブごとの完全なガイドについては [プロンプトキャッシング](/reference/prompt-caching) を参照してください。

Anthropic API の価格設定では、キャッシュ読み取りは入力トークンよりも大幅に安く、キャッシュ書き込みはより高い乗数で請求されます。最新のレートと TTL 乗数については、Anthropic のプロンプトキャッシング価格を参照してください:
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### 例: ハートビートで 1 時間のキャッシュをウォームに保つ

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
    heartbeat:
      every: "55m"
```

### 例: エージェントごとのキャッシュ戦略を持つ混合トラフィック

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long" # ほとんどのエージェントのデフォルトベースライン
  list:
    - id: "research"
      default: true
      heartbeat:
        every: "55m" # 深いセッションのためにロングキャッシュをウォームに保つ
    - id: "alerts"
      params:
        cacheRetention: "none" # バースト通知のキャッシュ書き込みを避ける
```

`agents.list[].params` は選択されたモデルの `params` の上にマージされるため、`cacheRetention` のみをオーバーライドして、他のモデルのデフォルトをそのまま継承できます。

### 例: Anthropic 1M コンテキストベータヘッダーを有効にする

Anthropic の 1M コンテキストウィンドウは現在ベータゲートされています。サポートされている Opus または Sonnet モデルで `context1m` を有効にすると、OpenClaw は必要な `anthropic-beta` 値をインジェクトできます。

```yaml
agents:
  defaults:
    models:
      "anthropic/claude-opus-4-6":
        params:
          context1m: true
```

これは Anthropic の `context-1m-2025-08-07` ベータヘッダーにマッピングされます。

OAuth/サブスクリプショントークン（`sk-ant-oat-*`）で Anthropic を認証した場合、Anthropic が現在その組み合わせを HTTP 401 で拒否するため、OpenClaw は `context-1m-*` ベータヘッダーをスキップします。

## トークン圧力を削減するためのヒント

- `/compact` を使用して長いセッションを要約してください。
- ワークフローで大きなツール出力をトリミングしてください。
- スクリーンショット重視のセッションには `agents.defaults.imageMaxDimensionPx` を下げてください。
- スキルの説明を短く保ってください（スキルリストはプロンプトにインジェクトされます）。
- 冗長で探索的な作業には小さいモデルを優先してください。

スキルリストのオーバーヘッドの正確な計算式については [スキル](/tools/skills) を参照してください。
