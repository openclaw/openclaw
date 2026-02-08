---
summary: "OpenClaw メモリの仕組み（ワークスペース ファイル＋自動メモリ フラッシュ）"
read_when:
  - メモリ ファイルのレイアウトとワークフローを知りたいとき
  - 自動プレコンパクション メモリ フラッシュを調整したいとき
x-i18n:
  source_path: concepts/memory.md
  source_hash: e160dc678bb8fda2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:22:17Z
---

# メモリ

OpenClaw メモリは **エージェント ワークスペース内のプレーンな Markdown** です。ファイルが信頼できる唯一の情報源であり、モデルはディスクに書き込まれた内容だけを「記憶」します。

メモリ検索ツールは、アクティブなメモリ プラグイン（デフォルト: `memory-core`）によって提供されます。メモリ プラグインは `plugins.slots.memory = "none"` で無効化できます。

## メモリ ファイル（Markdown）

デフォルトのワークスペース レイアウトでは、2 つのメモリ レイヤーを使用します。

- `memory/YYYY-MM-DD.md`
  - 日次ログ（追記のみ）。
  - セッション開始時に「今日＋昨日」を読み込みます。
- `MEMORY.md`（任意）
  - 厳選された長期メモリ。
  - **メインのプライベート セッションでのみ読み込み**（グループ コンテキストでは決して読み込みません）。

これらのファイルはワークスペース（`agents.defaults.workspace`、デフォルト `~/.openclaw/workspace`）配下にあります。完全なレイアウトについては [Agent workspace](/concepts/agent-workspace) を参照してください。

## メモリを書き込むタイミング

- 判断、好み、永続的な事実は `MEMORY.md` に書き込みます。
- 日々のメモや実行中のコンテキストは `memory/YYYY-MM-DD.md` に書き込みます。
- 誰かが「これを覚えて」と言ったら、書き込みます（RAM に保持しません）。
- この領域は現在も進化中です。モデルにメモリ保存を促すと役立ちます。モデルは何をすべきか理解しています。
- 何かを確実に残したい場合は、**ボットにメモリへ書き込むよう依頼**してください。

## 自動メモリ フラッシュ（プレコンパクション ping）

セッションが **自動コンパクションに近づく** と、OpenClaw は **サイレントなエージェント ターン** をトリガーし、コンテキストが圧縮される **前** に永続メモリを書き込むようモデルに促します。デフォルトのプロンプトではモデルが _返信してもよい_ と明示されていますが、通常は `NO_REPLY` が正しい応答となり、ユーザーにこのターンが表示されることはありません。

これは `agents.defaults.compaction.memoryFlush` によって制御されます。

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

- **ソフトしきい値**: セッションのトークン推定値が `contextWindow - reserveTokensFloor - softThresholdTokens` を超えるとフラッシュがトリガーされます。
- **デフォルトでサイレント**: プロンプトに `NO_REPLY` が含まれるため、何も配信されません。
- **2 つのプロンプト**: ユーザー プロンプトとシステム プロンプトがリマインダーを追加します。
- **コンパクション サイクルごとに 1 回のフラッシュ**（`sessions.json` で追跡）。
- **ワークスペースが書き込み可能である必要**: セッションが `workspaceAccess: "ro"` または `"none"` でサンドボックス化されて実行されている場合、フラッシュはスキップされます。

コンパクションの完全なライフサイクルについては、
[Session management + compaction](/reference/session-management-compaction) を参照してください。

## ベクター メモリ検索

OpenClaw は `MEMORY.md` と `memory/*.md` 上に小さなベクター インデックスを構築でき、表現が異なっても関連ノートを意味検索で見つけられます。

デフォルト:

- デフォルトで有効。
- メモリ ファイルの変更を監視（デバウンス）。
- デフォルトではリモート埋め込みを使用。 `memorySearch.provider` が設定されていない場合、OpenClaw は自動選択します:
  1. `memorySearch.local.modelPath` が設定され、ファイルが存在する場合は `local`。
  2. OpenAI のキーを解決できる場合は `openai`。
  3. Gemini のキーを解決できる場合は `gemini`。
  4. Voyage のキーを解決できる場合は `voyage`。
  5. それ以外の場合、設定されるまでメモリ検索は無効のままです。
- ローカル モードは node-llama-cpp を使用し、`pnpm approve-builds` が必要になる場合があります。
- 利用可能な場合、sqlite-vec を使用して SQLite 内のベクター検索を高速化します。

リモート埋め込みには、埋め込みプロバイダーの API キーが **必須** です。OpenClaw は、認証プロファイル、`models.providers.*.apiKey`、または環境変数からキーを解決します。Codex OAuth はチャット／補完のみを対象としており、メモリ検索用の埋め込み要件は **満たしません**。Gemini では `GEMINI_API_KEY` または `models.providers.google.apiKey` を使用してください。Voyage では `VOYAGE_API_KEY` または `models.providers.voyage.apiKey` を使用してください。カスタムの OpenAI 互換エンドポイントを使用する場合は、`memorySearch.remote.apiKey`（および任意で `memorySearch.remote.headers`）を設定します。

### QMD バックエンド（実験的）

組み込みの SQLite インデクサーを [QMD](https://github.com/tobi/qmd) に置き換えるには `memory.backend = "qmd"` を設定します。QMD は、BM25＋ベクター＋再ランキングを組み合わせたローカル ファーストの検索サイドカーです。Markdown は信頼できる唯一の情報源のままで、OpenClaw は取得のために QMD を呼び出します。要点は次のとおりです。

**前提条件**

- デフォルトでは無効。設定ごとにオプトイン（`memory.backend = "qmd"`）。
- QMD CLI を別途インストール（`bun install -g https://github.com/tobi/qmd` またはリリースを取得）し、`qmd` バイナリがゲートウェイの `PATH` にあることを確認します。
- QMD には拡張を許可する SQLite ビルドが必要です（macOS では `brew install sqlite`）。
- QMD は Bun＋`node-llama-cpp` により完全にローカルで動作し、初回使用時に HuggingFace から GGUF モデルを自動ダウンロードします（別途 Ollama デーモンは不要）。
- ゲートウェイは、`XDG_CONFIG_HOME` と `XDG_CACHE_HOME` を設定することで、`~/.openclaw/agents/<agentId>/qmd/` 配下の自己完結型 XDG ホームで QMD を実行します。
- OS 対応: macOS と Linux は、Bun＋SQLite をインストールすればそのまま動作します。Windows は WSL2 経由での利用が最適です。

**サイドカーの実行方法**

- ゲートウェイは、`~/.openclaw/agents/<agentId>/qmd/` 配下に自己完結型の QMD ホーム（設定＋キャッシュ＋sqlite DB）を書き込みます。
- コレクションは `memory.qmd.paths`（およびデフォルトのワークスペース メモリ ファイル）から `qmd collection add` で作成され、その後 `qmd update`＋`qmd embed` が起動時および設定可能な間隔（`memory.qmd.update.interval`、デフォルト 5 分）で実行されます。
- 起動時のリフレッシュは、チャット起動をブロックしないようデフォルトでバックグラウンド実行になりました。従来のブロッキング動作を維持するには `memory.qmd.update.waitForBootSync = true` を設定します。
- 検索は `qmd query --json` 経由で実行されます。QMD が失敗するかバイナリが見つからない場合、OpenClaw は自動的に組み込みの SQLite マネージャーへフォールバックし、メモリ ツールは引き続き動作します。
- OpenClaw は現時点で QMD の埋め込みバッチ サイズ調整を公開していません。バッチ挙動は QMD 自身が制御します。
- **初回検索は遅い場合があります**: 初回の `qmd query` 実行時に、QMD がローカル GGUF モデル（再ランキング／クエリ拡張）をダウンロードすることがあります。
  - OpenClaw は QMD 実行時に `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` を自動設定します。
  - 手動でモデルを事前ダウンロード（同じインデックスをウォームアップ）したい場合は、エージェントの XDG ディレクトリを使ってワンオフ クエリを実行してください。

    OpenClaw の QMD 状態は **state ディレクトリ**（デフォルト `~/.openclaw`）配下にあります。同一の XDG 変数をエクスポートすることで、`qmd` を同じインデックスに向けられます。

    ```bash
    # Pick the same state dir OpenClaw uses
    STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
    if [ -d "$HOME/.moltbot" ] && [ ! -d "$HOME/.openclaw" ] \
      && [ -z "${OPENCLAW_STATE_DIR:-}" ]; then
      STATE_DIR="$HOME/.moltbot"
    fi

    export XDG_CONFIG_HOME="$STATE_DIR/agents/main/qmd/xdg-config"
    export XDG_CACHE_HOME="$STATE_DIR/agents/main/qmd/xdg-cache"

    # (Optional) force an index refresh + embeddings
    qmd update
    qmd embed

    # Warm up / trigger first-time model downloads
    qmd query "test" -c memory-root --json >/dev/null 2>&1
    ```

**設定サーフェス（`memory.qmd.*`）**

- `command`（デフォルト `qmd`）: 実行ファイル パスを上書き。
- `includeDefaultMemory`（デフォルト `true`）: `MEMORY.md`＋`memory/**/*.md` を自動インデックス。
- `paths[]`: 追加のディレクトリ／ファイルを追加（`path`、任意の `pattern`、任意の安定 `name`）。
- `sessions`: セッション JSONL のインデックス化にオプトイン（`enabled`、`retentionDays`、`exportDir`）。
- `update`: リフレッシュ頻度とメンテナンス実行を制御（`interval`、`debounceMs`、`onBoot`、`waitForBootSync`、`embedInterval`、`commandTimeoutMs`、`updateTimeoutMs`、`embedTimeoutMs`）。
- `limits`: リコール ペイロードをクランプ（`maxResults`、`maxSnippetChars`、`maxInjectedChars`、`timeoutMs`）。
- `scope`: [`session.sendPolicy`](/gateway/configuration#session) と同一のスキーマ。デフォルトは DM のみ（`deny` はすべて、`allow` はダイレクト チャット）。グループ／チャンネルで QMD ヒットを表示するには緩和します。
- ワークスペース外から取得したスニペットは、`memory_search` の結果で `qmd/<collection>/<relative-path>` として表示されます。`memory_get` はそのプレフィックスを理解し、設定された QMD コレクション ルートから読み取ります。
- `memory.qmd.sessions.enabled = true` の場合、OpenClaw はサニタイズ済みのセッション トランスクリプト（ユーザー／アシスタントのターン）を `~/.openclaw/agents/<id>/qmd/sessions/` 配下の専用 QMD コレクションにエクスポートし、組み込み SQLite インデックスに触れずに `memory_search` が最近の会話を想起できるようにします。
- `memory_search` スニペットには、`memory.citations` が `auto`/`on` の場合、`Source: <path#line>` フッターが含まれます。`memory.citations = "off"` を設定するとパス メタデータを内部扱いにできます（エージェントは `memory_get` のためにパスを受け取りますが、スニペット本文からはフッターが省かれ、システム プロンプトで引用しないよう警告されます）。

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
      rules: [{ action: "allow", match: { chatType: "direct" } }]
    },
    paths: [
      { name: "docs", path: "~/notes", pattern: "**/*.md" }
    ]
  }
}
```

**引用とフォールバック**

- `memory.citations` は、バックエンド（`auto`/`on`/`off`）に関わらず適用されます。
- `qmd` が実行されると、診断でどのエンジンが結果を提供したか分かるように `status().backend = "qmd"` をタグ付けします。QMD サブプロセスが終了するか JSON 出力を解析できない場合、検索マネージャーは警告をログに記録し、QMD が回復するまで組み込みプロバイダー（既存の Markdown 埋め込み）を返します。

### 追加のメモリ パス

デフォルトのワークスペース レイアウト外にある Markdown ファイルをインデックスしたい場合は、明示的なパスを追加します。

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

注記:

- パスは絶対パスまたはワークスペース相対にできます。
- ディレクトリは `.md` ファイルを再帰的にスキャンします。
- インデックスされるのは Markdown ファイルのみです。
- シンボリックリンク（ファイル／ディレクトリ）は無視されます。

### Gemini 埋め込み（ネイティブ）

Gemini の埋め込み API を直接使用するには、プロバイダーを `gemini` に設定します。

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

注記:

- `remote.baseUrl` は任意（デフォルトは Gemini API のベース URL）。
- `remote.headers` で必要に応じて追加ヘッダーを設定できます。
- デフォルト モデル: `gemini-embedding-001`。

**カスタム OpenAI 互換エンドポイント**（OpenRouter、vLLM、またはプロキシ）を使用したい場合は、OpenAI プロバイダーで `remote` 設定を使用できます。

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

API キーを設定したくない場合は `memorySearch.provider = "local"` を使用するか、`memorySearch.fallback = "none"` を設定してください。

フォールバック:

- `memorySearch.fallback` は `openai`、`gemini`、`local`、または `none` にできます。
- フォールバック プロバイダーは、プライマリの埋め込みプロバイダーが失敗した場合にのみ使用されます。

バッチ インデックス（OpenAI＋Gemini）:

- OpenAI と Gemini の埋め込みではデフォルトで有効。無効にするには `agents.defaults.memorySearch.remote.batch.enabled = false` を設定します。
- デフォルトではバッチ完了を待機します。必要に応じて `remote.batch.wait`、`remote.batch.pollIntervalMs`、`remote.batch.timeoutMinutes` を調整してください。
- 並列で送信するバッチ ジョブ数は `remote.batch.concurrency` で制御します（デフォルト: 2）。
- バッチ モードは `memorySearch.provider = "openai"` または `"gemini"` の場合に適用され、対応する API キーを使用します。
- Gemini のバッチ ジョブは非同期埋め込みバッチ エンドポイントを使用し、Gemini Batch API の提供が必要です。

OpenAI バッチが高速かつ低コストな理由:

- 大規模なバックフィルでは、単一のバッチ ジョブで多数の埋め込みリクエストを送信し、非同期処理できるため、OpenAI は通常、当社がサポートする中で最速の選択肢です。
- OpenAI は Batch API ワークロード向けの割引価格を提供しているため、同じリクエストを同期送信するよりも大規模なインデックス作成は安価になることが多いです。
- 詳細は OpenAI Batch API のドキュメントと価格をご覧ください:
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

- `memory_search` — ファイル＋行範囲付きのスニペットを返します。
- `memory_get` — パス指定でメモリ ファイルの内容を読み取ります。

ローカル モード:

- `agents.defaults.memorySearch.provider = "local"` を設定します。
- `agents.defaults.memorySearch.local.modelPath`（GGUF または `hf:` URI）を指定します。
- 任意: リモート フォールバックを避けるには `agents.defaults.memorySearch.fallback = "none"` を設定します。

### メモリ ツールの仕組み

- `memory_search` は、`MEMORY.md`＋`memory/**/*.md` から Markdown チャンク（目標 ~400 トークン、80 トークン重なり）を意味検索します。スニペット本文（約 700 文字上限）、ファイル パス、行範囲、スコア、プロバイダー／モデル、ローカル→リモート埋め込みへのフォールバック有無を返します。ファイル全体のペイロードは返しません。
- `memory_get` は、特定のメモリ Markdown ファイル（ワークスペース相対）を、開始行と N 行の指定付きで読み取ります。`MEMORY.md`／`memory/` 外のパスは拒否されます。
- 両ツールは、エージェントに対して `memorySearch.enabled` が true に解決された場合にのみ有効です。

### 何がインデックスされるか（およびタイミング）

- ファイル種別: Markdown のみ（`MEMORY.md`、`memory/**/*.md`）。
- インデックス保存先: エージェントごとの SQLite（`~/.openclaw/memory/<agentId>.sqlite`、`agents.defaults.memorySearch.store.path` で設定可能、`{agentId}` トークンをサポート）。
- 新鮮度: `MEMORY.md`＋`memory/` のウォッチャーがインデックスをダーティにします（デバウンス 1.5 秒）。同期はセッション開始時、検索時、または一定間隔でスケジュールされ、非同期に実行されます。セッション トランスクリプトはデルタしきい値でバックグラウンド同期をトリガーします。
- 再インデックス トリガー: インデックスは **プロバイダー／モデル＋エンドポイント フィンガープリント＋チャンク化パラメータ** を保存します。いずれかが変更されると、OpenClaw は自動的に全体をリセットして再インデックスします。

### ハイブリッド検索（BM25＋ベクター）

有効時、OpenClaw は次を組み合わせます。

- **ベクター類似度**（意味一致、表現が異なっても可）
- **BM25 キーワード関連度**（ID、環境変数、コード シンボルなどの完全一致）

プラットフォームで全文検索が利用できない場合、OpenClaw はベクターのみの検索にフォールバックします。

#### なぜハイブリッドか

ベクター検索は「同じ意味」を捉えるのが得意です。

- 「Mac Studio gateway host」 vs 「ゲートウェイを実行しているマシン」
- 「ファイル更新をデバウンス」 vs 「毎回の書き込みでインデックスしない」

一方、正確で高シグナルなトークンには弱いことがあります。

- ID（`a828e60`、`b3b9895a…`）
- コード シンボル（`memorySearch.query.hybrid`）
- エラー文字列（「sqlite-vec unavailable」）

BM25（全文検索）はその逆で、完全一致に強く、言い換えには弱いです。ハイブリッド検索は実用的な中間解です。**両方の取得シグナルを使う**ことで、「自然言語」クエリと「針の山探し」クエリの双方で良い結果が得られます。

#### 結果のマージ方法（現在の設計）

実装スケッチ:

1. 両側から候補プールを取得:

- **ベクター**: コサイン類似度の上位 `maxResults * candidateMultiplier`。
- **BM25**: FTS5 の BM25 ランク上位 `maxResults * candidateMultiplier`（低いほど良い）。

2. BM25 ランクを 0..1 程度のスコアに変換:

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. チャンク ID で候補を和集合し、重み付きスコアを計算:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

注記:

- `vectorWeight`＋`textWeight` は設定解決時に 1.0 に正規化され、重みが割合として振る舞います。
- 埋め込みが利用不可（またはプロバイダーがゼロ ベクターを返す）場合でも、BM25 を実行してキーワード一致を返します。
- FTS5 を作成できない場合、ベクターのみ検索を維持します（致命的エラーにはしません）。

これは「IR 理論的に完璧」ではありませんが、シンプルで高速で、実ノートに対する再現率／適合率を改善する傾向があります。将来的に高度化するなら、Reciprocal Rank Fusion（RRF）や、混合前のスコア正規化（min/max や z-score）が一般的な次の一手です。

設定:

```json5
agents: {
  defaults: {
    memorySearch: {
      query: {
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4
        }
      }
    }
  }
}
```

### 埋め込みキャッシュ

OpenClaw は SQLite に **チャンク埋め込み** をキャッシュでき、再インデックスや頻繁な更新（特にセッション トランスクリプト）で未変更テキストの再埋め込みを避けられます。

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

### セッション メモリ検索（実験的）

任意で **セッション トランスクリプト** をインデックスし、`memory_search` 経由で表示できます。
この機能は実験フラグの背後にあります。

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

注記:

- セッション インデックスは **オプトイン**（デフォルト無効）。
- セッション更新はデバウンスされ、デルタしきい値を超えると **非同期でインデックス** されます（ベストエフォート）。
- `memory_search` はインデックス待ちでブロックしません。バックグラウンド同期が完了するまで結果は多少古い可能性があります。
- 結果は引き続きスニペットのみを含みます。`memory_get` はメモリ ファイルに限定されたままです。
- セッション インデックスはエージェントごとに分離されます（そのエージェントのセッション ログのみが対象）。
- セッション ログはディスク上（`~/.openclaw/agents/<agentId>/sessions/*.jsonl`）に保存されます。ファイルシステムにアクセスできるプロセス／ユーザーは読み取れるため、ディスク アクセスを信頼境界として扱ってください。より厳密な分離が必要な場合は、エージェントを別の OS ユーザーやホストで実行してください。

デルタしきい値（デフォルト表示）:

```json5
agents: {
  defaults: {
    memorySearch: {
      sync: {
        sessions: {
          deltaBytes: 100000,   // ~100 KB
          deltaMessages: 50     // JSONL lines
        }
      }
    }
  }
}
```

### SQLite ベクター高速化（sqlite-vec）

sqlite-vec 拡張が利用可能な場合、OpenClaw は埋め込みを SQLite 仮想テーブル（`vec0`）に保存し、データベース内でベクター距離クエリを実行します。これにより、すべての埋め込みを JS に読み込まずに高速検索が可能になります。

設定（任意）:

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

注記:

- `enabled` はデフォルトで true。無効化すると、保存済み埋め込みに対するプロセス内コサイン類似度にフォールバックします。
- sqlite-vec 拡張が欠如している、または読み込みに失敗した場合、OpenClaw はエラーをログに記録し、JS フォールバック（ベクター テーブルなし）で継続します。
- `extensionPath` は同梱の sqlite-vec パスを上書きします（カスタム ビルドや非標準インストール場所に有用）。

### ローカル 埋め込みの自動ダウンロード

- デフォルトのローカル 埋め込みモデル: `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf`（約 0.6 GB）。
- `memorySearch.provider = "local"` の場合、`node-llama-cpp` は `modelPath` を解決します。GGUF が見つからない場合、キャッシュ（または設定時は `local.modelCacheDir`）に **自動ダウンロード** してから読み込みます。ダウンロードは再試行時に再開されます。
- ネイティブ ビルド要件: `pnpm approve-builds` を実行し、`node-llama-cpp` を選択してから `pnpm rebuild node-llama-cpp`。
- フォールバック: ローカル セットアップに失敗し、`memorySearch.fallback = "openai"` の場合、リモート 埋め込み（上書きがなければ `openai/text-embedding-3-small`）に自動切替し、その理由を記録します。

### カスタム OpenAI 互換エンドポイントの例

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

注記:

- `remote.*` は `models.providers.openai.*` より優先されます。
- `remote.headers` は OpenAI ヘッダーとマージされ、キー競合時はリモートが優先されます。OpenAI のデフォルトを使用するには `remote.headers` を省略してください。
