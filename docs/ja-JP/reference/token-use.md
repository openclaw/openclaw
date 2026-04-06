---
read_when:
    - トークン使用量、コスト、またはコンテキストウィンドウの説明
    - コンテキストの増大やコンパクション動作のデバッグ
summary: OpenClawがプロンプトコンテキストを構築し、トークン使用量とコストを報告する仕組み
title: トークン使用量とコスト
x-i18n:
    generated_at: "2026-04-02T07:54:13Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 337167ae60aef4954275cb6e0536d60b559c8157dab2f657eeb912d0a154c05f
    source_path: reference/token-use.md
    workflow: 15
---

# トークン使用量とコスト

OpenClawは文字数ではなく**トークン**を追跡します。トークンはモデル固有ですが、ほとんどのOpenAIスタイルのモデルでは英語テキストで1トークンあたり平均約4文字です。

## システムプロンプトの構築方法

OpenClawは実行のたびに独自のシステムプロンプトを組み立てます。含まれるものは以下の通りです：

- ツール一覧と短い説明
- Skills一覧（メタデータのみ。指示は`read`でオンデマンドに読み込まれます）
- 自己更新の指示
- ワークスペースとブートストラップファイル（`AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`、新規時の`BOOTSTRAP.md`、および存在する場合は`MEMORY.md`、小文字の`memory.md`がフォールバック）。大きなファイルは`agents.defaults.bootstrapMaxChars`（デフォルト: 20000）で切り詰められ、ブートストラップ注入の合計は`agents.defaults.bootstrapTotalMaxChars`（デフォルト: 150000）で上限が設定されます。`memory/*.md`ファイルはメモリツール経由のオンデマンドであり、自動注入されません。
- 時刻（UTCとユーザーのタイムゾーン）
- 返信タグとハートビート動作
- ランタイムメタデータ（ホスト/OS/モデル/思考）

完全な内訳は[システムプロンプト](/concepts/system-prompt)を参照してください。

## コンテキストウィンドウにカウントされるもの

モデルが受け取るすべてがコンテキスト制限にカウントされます：

- システムプロンプト（上記のすべてのセクション）
- 会話履歴（ユーザー＋アシスタントのメッセージ）
- ツール呼び出しとツール結果
- 添付ファイル/トランスクリプト（画像、音声、ファイル）
- コンパクションの要約とプルーニングの成果物
- プロバイダーのラッパーや安全ヘッダー（表示されませんが、カウントされます）

画像については、OpenClawはプロバイダー呼び出し前にトランスクリプト/ツールの画像ペイロードをダウンスケールします。
`agents.defaults.imageMaxDimensionPx`（デフォルト: `1200`）で調整できます：

- 値を下げると、通常はビジョントークンの使用量とペイロードサイズが削減されます。
- 値を上げると、OCR/UIが多いスクリーンショットでより多くの視覚的詳細が保持されます。

注入されるファイル、ツール、Skills、システムプロンプトサイズごとの実践的な内訳については、`/context list`または`/context detail`を使用してください。[コンテキスト](/concepts/context)を参照してください。

## 現在のトークン使用量を確認する方法

チャットで以下を使用してください：

- `/status` → セッションモデル、コンテキスト使用量、最後のレスポンスの入力/出力トークン、および**推定コスト**（APIキーのみ）を含む**絵文字付きステータスカード**。
- `/usage off|tokens|full` → すべての返信に**レスポンスごとの使用量フッター**を追加します。
  - セッションごとに永続化されます（`responseUsage`として保存）。
  - OAuth認証では**コストが非表示**になります（トークンのみ）。
- `/usage cost` → OpenClawのセッションログからローカルのコスト概要を表示します。

その他のサーフェス：

- **TUI/Web TUI:** `/status`と`/usage`がサポートされています。
- **CLI:** `openclaw status --usage`と`openclaw channels list`でプロバイダーのクォータウィンドウが表示されます（レスポンスごとのコストではありません）。

## コスト推定（表示される場合）

コストはモデルの価格設定から推定されます：

```
models.providers.<provider>.models[].cost
```

これらは`input`、`output`、`cacheRead`、`cacheWrite`の**100万トークンあたりのUSD**です。価格設定がない場合、OpenClawはトークンのみを表示します。OAuthトークンではドルコストは表示されません。

## キャッシュTTLとプルーニングの影響

プロバイダーのプロンプトキャッシュはキャッシュTTLウィンドウ内でのみ適用されます。OpenClawはオプションで**キャッシュTTLプルーニング**を実行できます：キャッシュTTLが期限切れになるとセッションをプルーニングし、キャッシュウィンドウをリセットすることで、後続のリクエストが完全な履歴を再キャッシュする代わりに、新たにキャッシュされたコンテキストを再利用できるようにします。これにより、セッションがTTLを超えてアイドル状態になった場合のキャッシュ書き込みコストが低く抑えられます。

[Gatewayの設定](/gateway/configuration)で構成し、動作の詳細は[セッションプルーニング](/concepts/session-pruning)を参照してください。

ハートビートはアイドル期間をまたいでキャッシュを**ウォーム**に保つことができます。モデルのキャッシュTTLが`1h`の場合、ハートビート間隔をそれよりわずかに短く（例: `55m`）設定すると、完全なプロンプトの再キャッシュを回避でき、キャッシュ書き込みコストを削減できます。

マルチエージェント構成では、共有モデル設定を1つ維持し、`agents.list[].params.cacheRetention`でエージェントごとにキャッシュ動作を調整できます。

ノブごとの詳細ガイドは[プロンプトキャッシュ](/reference/prompt-caching)を参照してください。

Anthropic APIの価格設定では、キャッシュ読み取りは入力トークンよりも大幅に安価であり、キャッシュ書き込みはより高い倍率で課金されます。最新の料金とTTL倍率については、Anthropicのプロンプトキャッシュの価格設定を参照してください：
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### 例: ハートビートで1時間キャッシュをウォームに保つ

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

### 例: エージェントごとのキャッシュ戦略による混合トラフィック

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long" # default baseline for most agents
  list:
    - id: "research"
      default: true
      heartbeat:
        every: "55m" # keep long cache warm for deep sessions
    - id: "alerts"
      params:
        cacheRetention: "none" # avoid cache writes for bursty notifications
```

`agents.list[].params`は選択されたモデルの`params`の上にマージされるため、`cacheRetention`のみをオーバーライドし、他のモデルデフォルトはそのまま継承できます。

### 例: Anthropic 1Mコンテキストベータヘッダーを有効にする

Anthropicの1Mコンテキストウィンドウは現在ベータゲートされています。OpenClawは、サポートされているOpusまたはSonnetモデルで`context1m`を有効にすると、必要な`anthropic-beta`値を注入できます。

```yaml
agents:
  defaults:
    models:
      "anthropic/claude-opus-4-6":
        params:
          context1m: true
```

これはAnthropicの`context-1m-2025-08-07`ベータヘッダーにマッピングされます。

これは、そのモデルエントリで`context1m: true`が設定されている場合にのみ適用されます。

要件: クレデンシャルがロングコンテキスト使用の対象である必要があります（APIキー課金、またはExtra Usageが有効なサブスクリプション）。対象でない場合、Anthropicは`HTTP 429: rate_limit_error: Extra usage is required for long context requests`で応答します。

OAuth/サブスクリプショントークン（`sk-ant-oat-*`）でAnthropicを認証する場合、Anthropicが現在その組み合わせをHTTP 401で拒否するため、OpenClawは`context-1m-*`ベータヘッダーをスキップします。

## トークン圧力を削減するためのヒント

- `/compact`を使用して長いセッションを要約する。
- ワークフローで大きなツール出力を削減する。
- スクリーンショットが多いセッションでは`agents.defaults.imageMaxDimensionPx`を下げる。
- Skillの説明を短く保つ（Skillリストはプロンプトに注入されます）。
- 冗長で探索的な作業にはより小さなモデルを使用する。

正確なSkillリストのオーバーヘッドの計算式については[Skills](/tools/skills)を参照してください。
