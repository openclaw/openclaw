---
title: "メモリ"
summary: "OpenClawメモリの仕組み（ワークスペースファイル + 自動メモリフラッシュ）"
read_when:
  - You want the memory file layout and workflow
  - You want to tune the automatic pre-compaction memory flush
---

# メモリ

OpenClawのメモリは**エージェントワークスペース内のプレーンMarkdown**です。ファイルが信頼できる情報源であり、モデルはディスクに書き込まれたものだけを「記憶」します。

メモリ検索ツールはアクティブなメモリプラグイン（デフォルト: `memory-core`）によって提供されます。メモリプラグインを無効にするには`plugins.slots.memory = "none"`を設定してください。

## メモリファイル（Markdown）

デフォルトのワークスペースレイアウトは2つのメモリレイヤーを使用します:

- `memory/YYYY-MM-DD.md`
  - 日次ログ（追記のみ）。
  - セッション開始時に今日 + 昨日を読み込みます。
- `MEMORY.md`（オプション）
  - 厳選された長期メモリ。
  - **メインのプライベートセッションでのみ読み込み**（グループコンテキストでは読み込まれません）。

これらのファイルはワークスペース（`agents.defaults.workspace`、デフォルト`~/.openclaw/workspace`）配下に存在します。完全なレイアウトについては[エージェントワークスペース](/concepts/agent-workspace)を参照してください。

## メモリツール

OpenClawはこれらのMarkdownファイル用に2つのエージェント向けツールを公開しています:

- `memory_search` -- インデックス化されたスニペットに対するセマンティック検索。
- `memory_get` -- 特定のMarkdownファイル/行範囲のターゲット読み取り。

`memory_get`は**ファイルが存在しない場合にグレースフルにデグレード**するようになりました（例: 最初の書き込み前の今日の日次ログ）。ビルトインマネージャーとQMDバックエンドの両方が`ENOENT`をスローする代わりに`{ text: "", path }`を返すため、エージェントはツール呼び出しをtry/catchロジックでラップせずに「まだ何も記録されていない」を処理してワークフローを続行できます。

## メモリを書き込むタイミング

- 決定事項、設定、永続的な事実は`MEMORY.md`に記録します。
- 日常的なメモや実行中のコンテキストは`memory/YYYY-MM-DD.md`に記録します。
- 誰かが「これを覚えて」と言ったら、書き留めてください（RAMに保持しないでください）。
- この領域はまだ発展途上です。モデルにメモリを保存するよう促すと効果的です。モデルは何をすべきか理解します。
- 何かを定着させたい場合は、**ボットにメモリに書き込むよう依頼してください**。

## 自動メモリフラッシュ（コンパクション前のping）

セッションが**自動コンパクションに近づいた**とき、OpenClawはコンテキストがコンパクションされる**前に**永続的なメモリを書き込むようモデルに促す**サイレントなエージェントターン**をトリガーします。デフォルトのプロンプトはモデルが_返信してもよい_と明示的に述べていますが、通常は`NO_REPLY`が正しい応答であり、ユーザーにこのターンが見えることはありません。

これは`agents.defaults.compaction.memoryFlush`で制御されます:

```json5
{
  agents: {
    defaults: {
      compaction: {
        reserveTokensFloor: 20000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

詳細:

- **ソフト閾値**: セッショントークンの推定値が`contextWindow - reserveTokensFloor - softThresholdTokens`を超えるとフラッシュがトリガーされます。
- デフォルトでは**サイレント**: プロンプトに`NO_REPLY`が含まれるため、何も配信されません。
- **2つのプロンプト**: ユーザープロンプトとシステムプロンプトがリマインダーを追加します。
- **コンパクションサイクルごとに1回のフラッシュ**（`sessions.json`で追跡）。
- **ワークスペースが書き込み可能であること**: セッションが`workspaceAccess: "ro"`または`"none"`でサンドボックス化されている場合、フラッシュはスキップされます。

完全なコンパクションライフサイクルについては、[セッション管理 + コンパクション](/reference/session-management-compaction)を参照してください。

## ベクトルメモリ検索

OpenClawは`MEMORY.md`と`memory/*.md`に対する小さなベクトルインデックスを構築でき、表現が異なっていてもセマンティッククエリで関連するメモを見つけることができます。

デフォルト:

- デフォルトで有効。
- メモリファイルの変更を監視（デバウンス付き）。
- メモリ検索は`agents.defaults.memorySearch`配下で設定（トップレベルの`memorySearch`ではありません）。
- デフォルトではリモートエンベディングを使用。`memorySearch.provider`が未設定の場合、OpenClawは自動選択します:
  1. `memorySearch.local.modelPath`が設定されていてファイルが存在する場合は`local`。
  2. OpenAIキーが解決できる場合は`openai`。
  3. Geminiキーが解決できる場合は`gemini`。
  4. Voyageキーが解決できる場合は`voyage`。
  5. Mistralキーが解決できる場合は`mistral`。
  6. それ以外の場合、メモリ検索は設定されるまで無効のままです。
- ローカルモードはnode-llama-cppを使用し、`pnpm approve-builds`が必要な場合があります。
- sqlite-vec（利用可能な場合）を使用してSQLite内のベクトル検索を高速化します。

リモートエンベディングにはエンベディングプロバイダーのAPIキーが**必要**です。OpenClawは認証プロファイル、`models.providers.*.apiKey`、または環境変数からキーを解決します。Codex OAuthはchat/completionsのみをカバーし、メモリ検索のエンベディングには対応して**いません**。Geminiの場合は`GEMINI_API_KEY`または`models.providers.google.apiKey`を使用してください。Voyageの場合は`VOYAGE_API_KEY`または`models.providers.voyage.apiKey`を使用してください。Mistralの場合は`MISTRAL_API_KEY`または`models.providers.mistral.apiKey`を使用してください。
カスタムOpenAI互換エンドポイントを使用する場合は、`memorySearch.remote.apiKey`（およびオプションの`memorySearch.remote.headers`）を設定してください。

### QMDバックエンド（実験的）

`memory.backend = "qmd"`を設定すると、ビルトインのSQLiteインデクサーを[QMD](https://github.com/tobi/qmd)に切り替えます。QMDはBM25 + ベクトル + リランキングを組み合わせたローカルファーストの検索サイドカーです。Markdownが信頼できる情報源のまま、OpenClawは検索にQMDをシェルアウトします。主なポイント:

**前提条件**

- デフォルトでは無効。設定ごとにオプトイン（`memory.backend = "qmd"`）。
- QMD CLIを別途インストール（`bun install -g https://github.com/tobi/qmd`またはリリースを取得）し、`qmd`バイナリがGatewayの`PATH`にあることを確認してください。
- QMDにはエクステンションを許可するSQLiteビルドが必要です（macOSでは`brew install sqlite`）。
- QMDはBun + `node-llama-cpp`を介して完全にローカルで実行され、初回使用時にHuggingFaceからGGUFモデルを自動ダウンロードします（別途のOllamaデーモンは不要）。
- Gatewayは`XDG_CONFIG_HOME`と`XDG_CACHE_HOME`を設定して、`~/.openclaw/agents/<agentId>/qmd/`配下の自己完結型XDGホームでQMDを実行します。
- OSサポート: macOSとLinuxはBun + SQLiteがインストールされていればすぐに使用できます。WindowsはWSL2経由が最適です。

**サイドカーの実行方法**

- Gatewayは`~/.openclaw/agents/<agentId>/qmd/`配下に自己完結型QMDホーム（設定 + キャッシュ + SQLite DB）を書き込みます。
- コレクションは`memory.qmd.paths`から`qmd collection add`で作成され（デフォルトのワークスペースメモリファイルも含む）、起動時と設定可能な間隔（`memory.qmd.update.interval`、デフォルト5分）で`qmd update` + `qmd embed`が実行されます。
- Gatewayは起動時にQMDマネージャーを初期化するため、最初の`memory_search`呼び出しの前でも定期更新タイマーが有効になります。
- 起動時のリフレッシュはデフォルトでバックグラウンドで実行されるため、チャットの起動がブロックされません。以前のブロッキング動作を維持するには`memory.qmd.update.waitForBootSync = true`を設定してください。
- 検索は`memory.qmd.searchMode`（デフォルト`qmd search --json`、`vsearch`と`query`もサポート）で実行されます。選択したモードがQMDビルドのフラグを拒否する場合、OpenClawは`qmd query`でリトライします。QMDが失敗するかバイナリが見つからない場合、OpenClawはメモリツールが引き続き動作するようにビルトインのSQLiteマネージャーに自動的にフォールバックします。
- OpenClawは現在QMDのエンベディングバッチサイズの調整を公開していません。バッチ動作はQMD自体が制御します。
- **最初の検索が遅い場合があります**: QMDは最初の`qmd query`実行時にローカルGGUFモデル（リランカー/クエリ拡張）をダウンロードする場合があります。
  - OpenClawはQMD実行時に`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`を自動的に設定します。
  - 手動でモデルを事前ダウンロードしたい（そしてOpenClawが使用するのと同じインデックスをウォームアップしたい）場合は、エージェントのXDGディレクトリで一回限りのクエリを実行してください。

    OpenClawのQMD状態は**ステートディレクトリ**（デフォルトは`~/.openclaw`）配下にあります。OpenClawが使用するのと同じXDG変数をエクスポートすることで、`qmd`を同じインデックスに向けることができます:

    ```bash
    # OpenClawが使用するのと同じステートディレクトリを選択
    STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"

    export XDG_CONFIG_HOME="$STATE_DIR/agents/main/qmd/xdg-config"
    export XDG_CACHE_HOME="$STATE_DIR/agents/main/qmd/xdg-cache"

    # （オプション）インデックスのリフレッシュ + エンベディングを強制
    qmd update
    qmd embed

    # ウォームアップ / 初回モデルダウンロードをトリガー
    qmd query "test" -c memory-root --json >/dev/null 2>&1
    ```

**設定サーフェス（`memory.qmd.*`）**

- `command`（デフォルト`qmd`）: 実行ファイルパスのオーバーライド。
- `searchMode`（デフォルト`search`）: `memory_search`を裏で支えるQMDコマンドを選択（`search`、`vsearch`、`query`）。
- `includeDefaultMemory`（デフォルト`true`）: `MEMORY.md` + `memory/**/*.md`を自動インデックス。
- `paths[]`: 追加のディレクトリ/ファイルを追加（`path`、オプションの`pattern`、オプションの安定した`name`）。
- `sessions`: セッションJSONLインデックスのオプトイン（`enabled`、`retentionDays`、`exportDir`）。
- `update`: リフレッシュ頻度とメンテナンス実行を制御（`interval`、`debounceMs`、`onBoot`、`waitForBootSync`、`embedInterval`、`commandTimeoutMs`、`updateTimeoutMs`、`embedTimeoutMs`）。
- `limits`: 検索ペイロードのクランプ（`maxResults`、`maxSnippetChars`、`maxInjectedChars`、`timeoutMs`）。
- `scope`: [`session.sendPolicy`](/gateway/configuration#session)と同じスキーマ。デフォルトはDMのみ（すべて`deny`、ダイレクトチャットを`allow`）。グループ/チャンネルでQMDヒットを表示するには緩めてください。
  - `match.keyPrefix`は**正規化された**セッションキー（小文字化、先頭の`agent:<id>:`を除去）にマッチします。例: `discord:channel:`。
  - `match.rawKeyPrefix`は`agent:<id>:`を含む**生の**セッションキー（小文字化）にマッチします。例: `agent:main:discord:`。
  - レガシー: `match.keyPrefix: "agent:..."`は依然として生キープレフィックスとして扱われますが、明確さのために`rawKeyPrefix`を推奨します。
- `scope`が検索を拒否した場合、OpenClawは空の結果をデバッグしやすくするために派生した`channel`/`chatType`を含む警告をログに記録します。
- ワークスペース外からのスニペットは`memory_search`結果で`qmd/<collection>/<relative-path>`として表示されます。`memory_get`はそのプレフィックスを理解し、設定されたQMDコレクションルートから読み取ります。
- `memory.qmd.sessions.enabled = true`の場合、OpenClawはサニタイズされたセッションのトランスクリプト（User/Assistantターン）を`~/.openclaw/agents/<id>/qmd/sessions/`配下の専用QMDコレクションにエクスポートするため、`memory_search`はビルトインのSQLiteインデックスに触れずに最近の会話を思い出すことができます。
- `memory.citations`が`auto`/`on`の場合、`memory_search`スニペットに`Source: <path#line>`フッターが含まれます。`memory.citations = "off"`に設定するとパスメタデータを内部に保持します（エージェントは`memory_get`のためにパスを受け取りますが、スニペットテキストにフッターは省略され、システムプロンプトがエージェントに引用しないよう警告します）。

**例**

```json5
memory: {
  backend: "qmd",
  citations: "auto",
  qmd: {
    includeDefaultMemory: true,
    update: { interval: "5m", debounceMs: 15000 },
    limits: { maxResults: 6, timeoutMs: 4000 },
    scope: {
      default: "deny",
      rules: [
        { action: "allow", match: { chatType: "direct" } },
        // 正規化されたセッションキープレフィックス（`agent:<id>:`を除去）。
        { action: "deny", match: { keyPrefix: "discord:channel:" } },
        // 生のセッションキープレフィックス（`agent:<id>:`を含む）。
        { action: "deny", match: { rawKeyPrefix: "agent:main:discord:" } },
      ]
    },
    paths: [
      { name: "docs", path: "~/notes", pattern: "**/*.md" }
    ]
  }
}
```

**引用とフォールバック**

- `memory.citations`はバックエンドに関係なく適用されます（`auto`/`on`/`off`）。
- `qmd`実行時、`status().backend = "qmd"`をタグ付けして、どのエンジンが結果を提供したかを診断で表示します。QMDサブプロセスが終了するかJSON出力を解析できない場合、検索マネージャーは警告をログに記録し、QMDが回復するまでビルトインプロバイダー（既存のMarkdownエンベディング）を返します。

### 追加メモリパス

デフォルトのワークスペースレイアウト外のMarkdownファイルをインデックスしたい場合は、明示的なパスを追加してください:

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

注意事項:

- パスは絶対パスまたはワークスペース相対パスが使用できます。
- ディレクトリは`.md`ファイルを再帰的にスキャンします。
- Markdownファイルのみがインデックスされます。
- シンボリックリンクは無視されます（ファイルまたはディレクトリ）。

### Geminiエンベディング（ネイティブ）

プロバイダーを`gemini`に設定して、Geminiエンベディング APIを直接使用します:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "gemini",
      model: "gemini-embedding-001",
      remote: {
        apiKey: "YOUR_GEMINI_API_KEY"
      }
    }
  }
}
```

注意事項:

- `remote.baseUrl`はオプションです（デフォルトでGemini APIベースURLを使用）。
- `remote.headers`で必要に応じて追加ヘッダーを設定できます。
- デフォルトモデル: `gemini-embedding-001`。

**カスタムOpenAI互換エンドポイント**（OpenRouter、vLLM、またはプロキシ）を使用したい場合は、OpenAIプロバイダーで`remote`設定を使用できます:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_OPENAI_COMPAT_API_KEY",
        headers: { "X-Custom-Header": "value" }
      }
    }
  }
}
```

APIキーを設定したくない場合は、`memorySearch.provider = "local"`を使用するか、`memorySearch.fallback = "none"`を設定してください。

フォールバック:

- `memorySearch.fallback`は`openai`、`gemini`、`voyage`、`mistral`、`local`、または`none`を指定できます。
- フォールバックプロバイダーはプライマリエンベディングプロバイダーが失敗した場合にのみ使用されます。

バッチインデックス（OpenAI + Gemini + Voyage）:

- デフォルトでは無効。大規模コーパスのインデックスにはOpenAI、Gemini、およびVoyageで`agents.defaults.memorySearch.remote.batch.enabled = true`を設定して有効にしてください。
- デフォルトの動作はバッチ完了を待機します。必要に応じて`remote.batch.wait`、`remote.batch.pollIntervalMs`、`remote.batch.timeoutMinutes`を調整してください。
- `remote.batch.concurrency`で並列に送信するバッチジョブの数を制御します（デフォルト: 2）。
- バッチモードは`memorySearch.provider = "openai"`または`"gemini"`の場合に適用され、対応するAPIキーを使用します。
- Geminiバッチジョブは非同期エンベディングバッチエンドポイントを使用し、Gemini Batch APIの利用可能性が必要です。

OpenAIバッチが高速で安価な理由:

- 大規模なバックフィルの場合、OpenAIは通常サポートされている中で最も高速なオプションです。多くのエンベディングリクエストを単一のバッチジョブで送信し、OpenAIが非同期で処理できるためです。
- OpenAIはBatch APIワークロードに割引価格を提供しているため、大規模なインデックス実行は通常、同じリクエストを同期的に送信するよりも安価です。
- 詳細はOpenAI Batch APIドキュメントと価格をご確認ください:
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

設定例:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "openai",
      remote: {
        batch: { enabled: true, concurrency: 2 }
      },
      sync: { watch: true }
    }
  }
}
```

ツール:

- `memory_search` -- ファイル + 行範囲を含むスニペットを返します。
- `memory_get` -- パスでメモリファイルの内容を読み取ります。

ローカルモード:

- `agents.defaults.memorySearch.provider = "local"`を設定します。
- `agents.defaults.memorySearch.local.modelPath`を提供します（GGUFまたは`hf:` URI）。
- オプション: リモートフォールバックを避けるために`agents.defaults.memorySearch.fallback = "none"`を設定します。

### メモリツールの動作方法

- `memory_search`は`MEMORY.md` + `memory/**/*.md`のMarkdownチャンク（約400トークンターゲット、80トークンオーバーラップ）をセマンティックに検索します。スニペットテキスト（約700文字上限）、ファイルパス、行範囲、スコア、プロバイダー/モデル、ローカル → リモートエンベディングにフォールバックしたかどうかを返します。完全なファイルペイロードは返されません。
- `memory_get`は特定のメモリMarkdownファイル（ワークスペース相対）を、オプションで開始行からN行分読み取ります。`MEMORY.md` / `memory/`外のパスは拒否されます。
- 両方のツールはエージェントの`memorySearch.enabled`がtrueに解決される場合にのみ有効です。

### インデックスされるもの（とタイミング）

- ファイルタイプ: Markdownのみ（`MEMORY.md`、`memory/**/*.md`）。
- インデックスストレージ: エージェントごとのSQLite（`~/.openclaw/memory/<agentId>.sqlite`、`agents.defaults.memorySearch.store.path`で設定可能、`{agentId}`トークンをサポート）。
- 鮮度: `MEMORY.md` + `memory/`のウォッチャーがインデックスをダーティとマーク（デバウンス1.5秒）。同期はセッション開始時、検索時、または間隔でスケジュールされ、非同期で実行されます。セッションのトランスクリプトはデルタ閾値を使用してバックグラウンド同期をトリガーします。
- 再インデックスのトリガー: インデックスはエンベディングの**プロバイダー/モデル + エンドポイントフィンガープリント + チャンキングパラメータ**を保存します。いずれかが変更された場合、OpenClawは自動的にストア全体をリセットして再インデックスします。

### ハイブリッド検索（BM25 + ベクトル）

有効にすると、OpenClawは以下を組み合わせます:

- **ベクトル類似度**（セマンティックマッチ、表現が異なっていても可）
- **BM25キーワード関連度**（ID、環境変数、コードシンボルなどの正確なトークン）

フルテキスト検索がプラットフォームで利用できない場合、OpenClawはベクトルのみの検索にフォールバックします。

#### なぜハイブリッドか？

ベクトル検索は「同じ意味」を見つけるのが得意です:

- 「Mac Studio gateway host」vs「the machine running the gateway」
- 「debounce file updates」vs「avoid indexing on every write」

しかし、正確で重要度の高いトークンには弱いことがあります:

- ID（`a828e60`、`b3b9895a…`）
- コードシンボル（`memorySearch.query.hybrid`）
- エラー文字列（「sqlite-vec unavailable」）

BM25（フルテキスト）はその逆です: 正確なトークンに強く、言い換えには弱い。
ハイブリッド検索は実用的な中間地点です: **両方の検索シグナルを使用**することで、「自然言語」クエリと「干し草の中の針」クエリの両方で良い結果を得ます。

#### 結果のマージ方法（現在の設計）

実装スケッチ:

1. 両側から候補プールを取得:

- **ベクトル**: コサイン類似度による上位`maxResults * candidateMultiplier`件。
- **BM25**: FTS5 BM25ランクによる上位`maxResults * candidateMultiplier`件（低い方が良い）。

2. BM25ランクを0..1スコアに変換:

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. チャンクIDで候補を結合し、重み付きスコアを計算:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

注意事項:

- `vectorWeight` + `textWeight`は設定解決時に1.0に正規化されるため、重みはパーセンテージとして動作します。
- エンベディングが利用できない（またはプロバイダーがゼロベクトルを返す）場合でも、BM25を実行してキーワードマッチを返します。
- FTS5を作成できない場合、ベクトルのみの検索を維持します（ハード障害なし）。

これは「IR理論的に完璧」ではありませんが、シンプルで高速で、実際のメモでの再現率/精度を向上させる傾向があります。
後でより高度にしたい場合、一般的な次のステップはReciprocal Rank Fusion（RRF）またはスコア正規化（min/maxまたはzスコア）を混合前に適用することです。

#### 後処理パイプライン

ベクトルとキーワードスコアのマージ後、2つのオプションの後処理ステージがエージェントに届く前に結果リストを精緻化します:

```
ベクトル + キーワード → 重み付きマージ → 時間的減衰 → ソート → MMR → 上位K結果
```

両ステージはデフォルトで**オフ**であり、独立して有効にできます。

#### MMRリランキング（多様性）

ハイブリッド検索が結果を返す際、複数のチャンクに類似または重複するコンテンツが含まれている場合があります。
例えば、「home network setup」を検索すると、すべて同じルーター設定に言及する異なる日次ノートから5つのほぼ同一のスニペットが返される可能性があります。

**MMR（Maximal Marginal Relevance）**は関連性と多様性のバランスを取るように結果をリランキングし、同じ情報を繰り返す代わりにクエリの異なる側面をカバーする上位結果を確保します。

動作の仕組み:

1. 結果は元の関連性（ベクトル + BM25重み付きスコア）でスコアリングされます。
2. MMRは反復的に以下を最大化する結果を選択します: `lambda x 関連性 - (1-lambda) x 選択済みとの最大類似度`。
3. 結果間の類似度はトークン化されたコンテンツに対するJaccardテキスト類似度で測定されます。

`lambda`パラメータはトレードオフを制御します:

- `lambda = 1.0` → 純粋な関連性（多様性ペナルティなし）
- `lambda = 0.0` → 最大多様性（関連性を無視）
- デフォルト: `0.7`（バランス型、やや関連性寄り）

**例 -- クエリ: 「home network setup」**

以下のメモリファイルがある場合:

```
memory/2026-02-10.md  → "Configured Omada router, set VLAN 10 for IoT devices"
memory/2026-02-08.md  → "Configured Omada router, moved IoT to VLAN 10"
memory/2026-02-05.md  → "Set up AdGuard DNS on 192.168.10.2"
memory/network.md     → "Router: Omada ER605, AdGuard: 192.168.10.2, VLAN 10: IoT"
```

MMRなし -- 上位3結果:

```
1. memory/2026-02-10.md  (score: 0.92)  ← router + VLAN
2. memory/2026-02-08.md  (score: 0.89)  ← router + VLAN (ほぼ重複!)
3. memory/network.md     (score: 0.85)  ← reference doc
```

MMRあり (lambda=0.7) -- 上位3結果:

```
1. memory/2026-02-10.md  (score: 0.92)  ← router + VLAN
2. memory/network.md     (score: 0.85)  ← reference doc (多様!)
3. memory/2026-02-05.md  (score: 0.78)  ← AdGuard DNS (多様!)
```

2月8日のほぼ重複のエントリは除外され、エージェントは3つの異なる情報を得ます。

**有効にすべきタイミング:** `memory_search`が冗長またはほぼ重複のスニペットを返すことに気づいた場合、特に日次ノートで日をまたいで類似の情報が繰り返されることが多い場合に有効です。

#### 時間的減衰（最新性ブースト）

日次ノートを持つエージェントは時間の経過とともに数百の日付付きファイルを蓄積します。減衰なしでは、6ヶ月前のよく書かれたメモが同じトピックの昨日の更新より高くランクされる可能性があります。

**時間的減衰**は各結果の経過時間に基づいて指数関数的な乗数をスコアに適用し、最近のメモリが自然に高くランクされ古いものがフェードします:

```
decayedScore = score x e^(-lambda x ageInDays)
```

ここで`lambda = ln(2) / halfLifeDays`。

デフォルトの半減期30日の場合:

- 今日のノート: 元のスコアの**100%**
- 7日前: **約84%**
- 30日前: **50%**
- 90日前: **12.5%**
- 180日前: **約1.6%**

**エバーグリーンファイルは減衰しません:**

- `MEMORY.md`（ルートメモリファイル）
- `memory/`内の日付なしファイル（例: `memory/projects.md`、`memory/network.md`）
- これらは常に通常通りランクされるべき永続的な参照情報を含みます。

**日付付き日次ファイル**（`memory/YYYY-MM-DD.md`）はファイル名から抽出された日付を使用します。
その他のソース（例: セッションのトランスクリプト）はファイル変更時刻（`mtime`）にフォールバックします。

**例 -- クエリ: 「what's Rod's work schedule?」**

以下のメモリファイルがある場合（今日は2月10日）:

```
memory/2025-09-15.md  → "Rod works Mon-Fri, standup at 10am, pairing at 2pm"  (148日前)
memory/2026-02-10.md  → "Rod has standup at 14:15, 1:1 with Zeb at 14:45"    (今日)
memory/2026-02-03.md  → "Rod started new team, standup moved to 14:15"        (7日前)
```

減衰なし:

```
1. memory/2025-09-15.md  (score: 0.91)  ← 最高のセマンティックマッチだが古い!
2. memory/2026-02-10.md  (score: 0.82)
3. memory/2026-02-03.md  (score: 0.80)
```

減衰あり (halfLife=30):

```
1. memory/2026-02-10.md  (score: 0.82 x 1.00 = 0.82)  ← 今日、減衰なし
2. memory/2026-02-03.md  (score: 0.80 x 0.85 = 0.68)  ← 7日前、軽度の減衰
3. memory/2025-09-15.md  (score: 0.91 x 0.03 = 0.03)  ← 148日前、ほぼ消失
```

9月の古いメモは最高の生セマンティックマッチスコアにもかかわらず最下位に落ちます。

**有効にすべきタイミング:** エージェントに数ヶ月分の日次ノートがあり、古くて陳腐化した情報が最新のコンテキストより高くランクされることに気づいた場合。30日の半減期は日次ノートが多いワークフローに適しています。古いノートを頻繁に参照する場合は半減期を延ばしてください（例: 90日）。

#### 設定

両方の機能は`memorySearch.query.hybrid`配下で設定します:

```json5
agents: {
  defaults: {
    memorySearch: {
      query: {
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4,
          // 多様性: 冗長な結果を削減
          mmr: {
            enabled: true,    // デフォルト: false
            lambda: 0.7       // 0 = 最大多様性, 1 = 最大関連性
          },
          // 最新性: 新しいメモリをブースト
          temporalDecay: {
            enabled: true,    // デフォルト: false
            halfLifeDays: 30  // 30日ごとにスコアが半減
          }
        }
      }
    }
  }
}
```

各機能を独立して有効にできます:

- **MMRのみ** -- 類似のメモが多いが経過時間が問題にならない場合に有効。
- **時間的減衰のみ** -- 最新性が重要だが結果が既に多様な場合に有効。
- **両方** -- 大規模で長期間にわたる日次ノート履歴を持つエージェントに推奨。

### エンベディングキャッシュ

OpenClawは**チャンクエンベディング**をSQLiteにキャッシュできるため、再インデックスや頻繁な更新（特にセッションのトランスクリプト）で変更されていないテキストを再エンベディングしません。

設定:

```json5
agents: {
  defaults: {
    memorySearch: {
      cache: {
        enabled: true,
        maxEntries: 50000
      }
    }
  }
}
```

### セッションメモリ検索（実験的）

オプションで**セッションのトランスクリプト**をインデックスし、`memory_search`で表示できます。
これは実験的フラグの背後にゲートされています。

```json5
agents: {
  defaults: {
    memorySearch: {
      experimental: { sessionMemory: true },
      sources: ["memory", "sessions"]
    }
  }
}
```

注意事項:

- セッションインデックスは**オプトイン**です（デフォルトではオフ）。
- セッション更新はデバウンスされ、デルタ閾値を超えると**非同期でインデックス**されます（ベストエフォート）。
- `memory_search`はインデックスでブロックしません。バックグラウンド同期が完了するまで結果はやや古くなる可能性があります。
- 結果にはスニペットのみが含まれます。`memory_get`はメモリファイルに限定されたままです。
- セッションインデックスはエージェントごとに分離されます（そのエージェントのセッションログのみがインデックスされます）。
- セッションログはディスク上に存在します（`~/.openclaw/agents/<agentId>/sessions/*.jsonl`）。ファイルシステムアクセスを持つプロセス/ユーザーはそれらを読み取れるため、ディスクアクセスを信頼境界として扱ってください。より厳格な分離のためには、エージェントを別のOSユーザーまたはホストで実行してください。

デルタ閾値（デフォルト値を表示）:

```json5
agents: {
  defaults: {
    memorySearch: {
      sync: {
        sessions: {
          deltaBytes: 100000,   // 約100 KB
          deltaMessages: 50     // JSONL行
        }
      }
    }
  }
}
```

### SQLiteベクトル高速化（sqlite-vec）

sqlite-vecエクステンションが利用可能な場合、OpenClawはエンベディングをSQLite仮想テーブル（`vec0`）に保存し、データベース内でベクトル距離クエリを実行します。これにより、すべてのエンベディングをJSに読み込まずに検索を高速に保ちます。

設定（オプション）:

```json5
agents: {
  defaults: {
    memorySearch: {
      store: {
        vector: {
          enabled: true,
          extensionPath: "/path/to/sqlite-vec"
        }
      }
    }
  }
}
```

注意事項:

- `enabled`のデフォルトはtrue。無効にすると、検索は保存されたエンベディングに対するインプロセスのコサイン類似度にフォールバックします。
- sqlite-vecエクステンションが見つからないか読み込みに失敗した場合、OpenClawはエラーをログに記録し、JSフォールバック（ベクトルテーブルなし）で続行します。
- `extensionPath`はバンドルされたsqlite-vecパスをオーバーライドします（カスタムビルドや非標準インストール場所に有用）。

### ローカルエンベディングの自動ダウンロード

- デフォルトのローカルエンベディングモデル: `hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf`（約0.6 GB）。
- `memorySearch.provider = "local"`の場合、`node-llama-cpp`が`modelPath`を解決します。GGUFが見つからない場合はキャッシュ（または`local.modelCacheDir`が設定されている場合はそこ）に**自動ダウンロード**し、読み込みます。ダウンロードはリトライ時に再開します。
- ネイティブビルド要件: `pnpm approve-builds`を実行し、`node-llama-cpp`を選択して`pnpm rebuild node-llama-cpp`。
- フォールバック: ローカルセットアップが失敗し`memorySearch.fallback = "openai"`の場合、リモートエンベディング（オーバーライドされていない限り`openai/text-embedding-3-small`）に自動切り替えし、理由を記録します。

### カスタムOpenAI互換エンドポイントの例

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_REMOTE_API_KEY",
        headers: {
          "X-Organization": "org-id",
          "X-Project": "project-id"
        }
      }
    }
  }
}
```

注意事項:

- `remote.*`は`models.providers.openai.*`より優先されます。
- `remote.headers`はOpenAIヘッダーとマージされます。キーが競合する場合はremoteが優先されます。OpenAIのデフォルトを使用するには`remote.headers`を省略してください。
