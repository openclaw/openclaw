---
read_when:
    - メモリ検索プロバイダーや埋め込みモデルを設定したい場合
    - QMDバックエンドをセットアップしたい場合
    - ハイブリッド検索、MMR、または時間減衰を調整したい場合
    - マルチモーダルメモリインデックスを有効にしたい場合
summary: メモリ検索、埋め込みプロバイダー、QMD、ハイブリッド検索、マルチモーダルインデックスのすべての設定項目
title: メモリ設定リファレンス
x-i18n:
    generated_at: "2026-04-02T07:52:43Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 5fd0aabe9adbee6aa9c89d7bf2bcd684f9fa4d823ec01bbb8c0e7901733cc262
    source_path: reference/memory-config.md
    workflow: 15
---

# メモリ設定リファレンス

このページでは、OpenClawメモリ検索のすべての設定項目を一覧で説明します。概念的な概要については以下を参照してください:

- [メモリ概要](/concepts/memory) -- メモリの仕組み
- [ビルトインエンジン](/concepts/memory-builtin) -- デフォルトのSQLiteバックエンド
- [QMDエンジン](/concepts/memory-qmd) -- ローカルファーストのサイドカー
- [メモリ検索](/concepts/memory-search) -- 検索パイプラインとチューニング

特に記載がない限り、すべてのメモリ検索設定は`openclaw.json`の`agents.defaults.memorySearch`配下にあります。

---

## プロバイダー選択

| キー       | 型        | デフォルト       | 説明                                                                             |
| ---------- | --------- | ---------------- | -------------------------------------------------------------------------------- |
| `provider` | `string`  | 自動検出         | 埋め込みアダプターID: `openai`、`gemini`、`voyage`、`mistral`、`ollama`、`local`  |
| `model`    | `string`  | プロバイダーのデフォルト | 埋め込みモデル名                                                                 |
| `fallback` | `string`  | `"none"`         | プライマリが失敗した場合のフォールバックアダプターID                              |
| `enabled`  | `boolean` | `true`           | メモリ検索を有効または無効にする                                                 |

### 自動検出の順序

`provider`が設定されていない場合、OpenClawは最初に利用可能なものを選択します:

1. `local` -- `memorySearch.local.modelPath`が設定されていて、ファイルが存在する場合。
2. `openai` -- OpenAIキーが解決できる場合。
3. `gemini` -- Geminiキーが解決できる場合。
4. `voyage` -- Voyageキーが解決できる場合。
5. `mistral` -- Mistralキーが解決できる場合。

`ollama`はサポートされていますが、自動検出されません（明示的に設定してください）。

### APIキーの解決

リモート埋め込みにはAPIキーが必要です。OpenClawは以下から解決します:
認証プロファイル、`models.providers.*.apiKey`、または環境変数。

| プロバイダー | 環境変数                       | 設定キー                          |
| ------------ | ------------------------------ | --------------------------------- |
| OpenAI       | `OPENAI_API_KEY`               | `models.providers.openai.apiKey`  |
| Gemini       | `GEMINI_API_KEY`               | `models.providers.google.apiKey`  |
| Voyage       | `VOYAGE_API_KEY`               | `models.providers.voyage.apiKey`  |
| Mistral      | `MISTRAL_API_KEY`              | `models.providers.mistral.apiKey` |
| Ollama       | `OLLAMA_API_KEY`（プレースホルダー） | --                                |

Codex OAuthはチャット/補完のみをカバーし、埋め込みリクエストには対応していません。

---

## リモートエンドポイント設定

カスタムOpenAI互換エンドポイントやプロバイダーデフォルトのオーバーライド用:

| キー             | 型       | 説明                                               |
| ---------------- | -------- | -------------------------------------------------- |
| `remote.baseUrl` | `string` | カスタムAPIベースURL                               |
| `remote.apiKey`  | `string` | APIキーのオーバーライド                            |
| `remote.headers` | `object` | 追加HTTPヘッダー（プロバイダーデフォルトにマージ） |

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        provider: "openai",
        model: "text-embedding-3-small",
        remote: {
          baseUrl: "https://api.example.com/v1/",
          apiKey: "YOUR_KEY",
        },
      },
    },
  },
}
```

---

## Gemini固有の設定

| キー                   | 型       | デフォルト             | 説明                                       |
| ---------------------- | -------- | ---------------------- | ------------------------------------------ |
| `model`                | `string` | `gemini-embedding-001` | `gemini-embedding-2-preview`もサポート     |
| `outputDimensionality` | `number` | `3072`                 | Embedding 2の場合: 768、1536、または3072   |

<Warning>
モデルまたは`outputDimensionality`を変更すると、自動的に完全な再インデックスがトリガーされます。
</Warning>

---

## ローカル埋め込み設定

| キー                  | 型       | デフォルト             | 説明                            |
| --------------------- | -------- | ---------------------- | ------------------------------- |
| `local.modelPath`     | `string` | 自動ダウンロード       | GGUFモデルファイルのパス        |
| `local.modelCacheDir` | `string` | node-llama-cppのデフォルト | ダウンロードモデルのキャッシュディレクトリ |

デフォルトモデル: `embeddinggemma-300m-qat-Q8_0.gguf`（約0.6 GB、自動ダウンロード）。
ネイティブビルドが必要です: `pnpm approve-builds`の後に`pnpm rebuild node-llama-cpp`を実行してください。

---

## ハイブリッド検索設定

すべて`memorySearch.query.hybrid`配下:

| キー                  | 型        | デフォルト | 説明                               |
| --------------------- | --------- | ---------- | ---------------------------------- |
| `enabled`             | `boolean` | `true`     | ハイブリッドBM25 + ベクトル検索を有効にする |
| `vectorWeight`        | `number`  | `0.7`      | ベクトルスコアの重み（0-1）        |
| `textWeight`          | `number`  | `0.3`      | BM25スコアの重み（0-1）            |
| `candidateMultiplier` | `number`  | `4`        | 候補プールサイズの乗数             |

### MMR（多様性）

| キー          | 型        | デフォルト | 説明                                 |
| ------------- | --------- | ---------- | ------------------------------------ |
| `mmr.enabled` | `boolean` | `false`    | MMR再ランキングを有効にする          |
| `mmr.lambda`  | `number`  | `0.7`      | 0 = 最大多様性、1 = 最大関連性       |

### 時間減衰（新しさ）

| キー                         | 型        | デフォルト | 説明                      |
| ---------------------------- | --------- | ---------- | ------------------------- |
| `temporalDecay.enabled`      | `boolean` | `false`    | 新しさブーストを有効にする |
| `temporalDecay.halfLifeDays` | `number`  | `30`       | N日ごとにスコアが半減する  |

エバーグリーンファイル（`MEMORY.md`、`memory/`内の日付なしファイル）は減衰されません。

### 完全な例

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        query: {
          hybrid: {
            vectorWeight: 0.7,
            textWeight: 0.3,
            mmr: { enabled: true, lambda: 0.7 },
            temporalDecay: { enabled: true, halfLifeDays: 30 },
          },
        },
      },
    },
  },
}
```

---

## 追加メモリパス

| キー         | 型         | 説明                                     |
| ------------ | ---------- | ---------------------------------------- |
| `extraPaths` | `string[]` | インデックスする追加のディレクトリまたはファイル |

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        extraPaths: ["../team-docs", "/srv/shared-notes"],
      },
    },
  },
}
```

パスは絶対パスまたはワークスペース相対パスで指定できます。ディレクトリは`.md`ファイルを再帰的にスキャンします。シンボリックリンクの処理はアクティブなバックエンドによって異なります: ビルトインエンジンはシンボリックリンクを無視し、QMDは基盤となるQMDスキャナーの動作に従います。

エージェントスコープのクロスエージェントトランスクリプト検索には、`memory.qmd.paths`の代わりに`agents.list[].memorySearch.qmd.extraCollections`を使用してください。これらの追加コレクションは同じ`{ path, name, pattern? }`の形式に従いますが、エージェントごとにマージされ、パスが現在のワークスペース外を指す場合に明示的な共有名を保持できます。
同じ解決済みパスが`memory.qmd.paths`と`memorySearch.qmd.extraCollections`の両方に存在する場合、QMDは最初のエントリを保持し、重複をスキップします。

---

## マルチモーダルメモリ（Gemini）

Gemini Embedding 2を使用して、Markdownと並行して画像と音声をインデックスします:

| キー                      | 型         | デフォルト | 説明                                   |
| ------------------------- | ---------- | ---------- | -------------------------------------- |
| `multimodal.enabled`      | `boolean`  | `false`    | マルチモーダルインデックスを有効にする |
| `multimodal.modalities`   | `string[]` | --         | `["image"]`、`["audio"]`、または`["all"]` |
| `multimodal.maxFileBytes` | `number`   | `10000000` | インデックスする最大ファイルサイズ     |

`extraPaths`内のファイルにのみ適用されます。デフォルトのメモリルートはMarkdownのみです。
`gemini-embedding-2-preview`が必要です。`fallback`は`"none"`でなければなりません。

サポートされる形式: `.jpg`、`.jpeg`、`.png`、`.webp`、`.gif`、`.heic`、`.heif`（画像）、`.mp3`、`.wav`、`.ogg`、`.opus`、`.m4a`、`.aac`、`.flac`（音声）。

---

## 埋め込みキャッシュ

| キー               | 型        | デフォルト | 説明                             |
| ------------------ | --------- | ---------- | -------------------------------- |
| `cache.enabled`    | `boolean` | `false`    | チャンク埋め込みをSQLiteにキャッシュする |
| `cache.maxEntries` | `number`  | `50000`    | キャッシュされる埋め込みの最大数 |

再インデックスやトランスクリプト更新時に、変更されていないテキストの再埋め込みを防ぎます。

---

## バッチインデックス

| キー                          | 型        | デフォルト | 説明                       |
| ----------------------------- | --------- | ---------- | -------------------------- |
| `remote.batch.enabled`        | `boolean` | `false`    | バッチ埋め込みAPIを有効にする |
| `remote.batch.concurrency`    | `number`  | `2`        | 並列バッチジョブ数         |
| `remote.batch.wait`           | `boolean` | `true`     | バッチ完了を待機する       |
| `remote.batch.pollIntervalMs` | `number`  | --         | ポーリング間隔             |
| `remote.batch.timeoutMinutes` | `number`  | --         | バッチタイムアウト         |

`openai`、`gemini`、`voyage`で利用可能です。OpenAIバッチは通常、大規模なバックフィルに対して最も高速かつ低コストです。

---

## セッションメモリ検索（実験的）

セッショントランスクリプトをインデックスし、`memory_search`経由で表示します:

| キー                          | 型         | デフォルト   | 説明                                    |
| ----------------------------- | ---------- | ------------ | --------------------------------------- |
| `experimental.sessionMemory`  | `boolean`  | `false`      | セッションインデックスを有効にする      |
| `sources`                     | `string[]` | `["memory"]` | トランスクリプトを含めるには`"sessions"`を追加 |
| `sync.sessions.deltaBytes`    | `number`   | `100000`     | 再インデックスのバイト閾値              |
| `sync.sessions.deltaMessages` | `number`   | `50`         | 再インデックスのメッセージ閾値          |

セッションインデックスはオプトインで非同期に実行されます。結果はわずかに古い場合があります。セッションログはディスク上にあるため、ファイルシステムアクセスを信頼境界として扱ってください。

---

## SQLiteベクトルアクセラレーション（sqlite-vec）

| キー                         | 型        | デフォルト | 説明                              |
| ---------------------------- | --------- | ---------- | --------------------------------- |
| `store.vector.enabled`       | `boolean` | `true`     | ベクトルクエリにsqlite-vecを使用する |
| `store.vector.extensionPath` | `string`  | バンドル済み | sqlite-vecパスのオーバーライド    |

sqlite-vecが利用できない場合、OpenClawはプロセス内コサイン類似度に自動的にフォールバックします。

---

## インデックスストレージ

| キー                  | 型       | デフォルト                            | 説明                                        |
| --------------------- | -------- | ------------------------------------- | ------------------------------------------- |
| `store.path`          | `string` | `~/.openclaw/memory/{agentId}.sqlite` | インデックスの場所（`{agentId}`トークンをサポート） |
| `store.fts.tokenizer` | `string` | `unicode61`                           | FTS5トークナイザー（`unicode61`または`trigram`） |

---

## QMDバックエンド設定

有効にするには`memory.backend = "qmd"`を設定します。すべてのQMD設定は`memory.qmd`配下にあります:

| キー                     | 型        | デフォルト | 説明                                         |
| ------------------------ | --------- | ---------- | -------------------------------------------- |
| `command`                | `string`  | `qmd`     | QMD実行ファイルのパス                        |
| `searchMode`             | `string`  | `search`  | 検索コマンド: `search`、`vsearch`、`query`   |
| `includeDefaultMemory`   | `boolean` | `true`    | `MEMORY.md` + `memory/**/*.md`を自動インデックス |
| `paths[]`                | `array`   | --        | 追加パス: `{ name, path, pattern? }`         |
| `sessions.enabled`       | `boolean` | `false`   | セッショントランスクリプトをインデックスする |
| `sessions.retentionDays` | `number`  | --        | トランスクリプトの保持期間                   |
| `sessions.exportDir`     | `string`  | --        | エクスポートディレクトリ                     |

### 更新スケジュール

| キー                      | 型        | デフォルト | 説明                                  |
| ------------------------- | --------- | ---------- | ------------------------------------- |
| `update.interval`         | `string`  | `5m`       | 更新間隔                              |
| `update.debounceMs`       | `number`  | `15000`    | ファイル変更のデバウンス              |
| `update.onBoot`           | `boolean` | `true`     | 起動時に更新する                      |
| `update.waitForBootSync`  | `boolean` | `false`    | 更新完了まで起動をブロックする        |
| `update.embedInterval`    | `string`  | --         | 埋め込みの個別ケイデンス              |
| `update.commandTimeoutMs` | `number`  | --         | QMDコマンドのタイムアウト             |

### 制限

| キー                      | 型       | デフォルト | 説明                       |
| ------------------------- | -------- | ---------- | -------------------------- |
| `limits.maxResults`       | `number` | `6`        | 検索結果の最大数           |
| `limits.maxSnippetChars`  | `number` | --         | スニペットの長さを制限する |
| `limits.maxInjectedChars` | `number` | --         | 注入される合計文字数を制限する |
| `limits.timeoutMs`        | `number` | `4000`     | 検索タイムアウト           |

### スコープ

どのセッションがQMD検索結果を受信できるかを制御します。[`session.sendPolicy`](/gateway/configuration-reference#session)と同じスキーマです:

```json5
{
  memory: {
    qmd: {
      scope: {
        default: "deny",
        rules: [{ action: "allow", match: { chatType: "direct" } }],
      },
    },
  },
}
```

デフォルトはダイレクトメッセージのみです。`match.keyPrefix`は正規化されたセッションキーに一致し、`match.rawKeyPrefix`は`agent:<id>:`を含む生のキーに一致します。

### 引用

`memory.citations`はすべてのバックエンドに適用されます:

| 値               | 動作                                                        |
| ---------------- | ----------------------------------------------------------- |
| `auto`（デフォルト） | スニペットに`Source: <path#line>`フッターを含める            |
| `on`             | 常にフッターを含める                                        |
| `off`            | フッターを省略する（パスは内部的にエージェントに渡される）  |

### QMDの完全な例

```json5
{
  memory: {
    backend: "qmd",
    citations: "auto",
    qmd: {
      includeDefaultMemory: true,
      update: { interval: "5m", debounceMs: 15000 },
      limits: { maxResults: 6, timeoutMs: 4000 },
      scope: {
        default: "deny",
        rules: [{ action: "allow", match: { chatType: "direct" } }],
      },
      paths: [{ name: "docs", path: "~/notes", pattern: "**/*.md" }],
    },
  },
}
```
