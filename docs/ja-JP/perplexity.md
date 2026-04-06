---
read_when:
    - Web検索にPerplexity Searchを使用したい場合
    - PERPLEXITY_API_KEYまたはOPENROUTER_API_KEYのセットアップが必要な場合
summary: Perplexity Search APIとweb_search向けのSonar/OpenRouter互換性
title: Perplexity Search（レガシーパス）
x-i18n:
    generated_at: "2026-04-02T07:46:45Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: c54b7732a1b9f61cce0834587a2fc2413f3f49b4087eca4001623fea453378db
    source_path: perplexity.md
    workflow: 15
---

# Perplexity Search API

OpenClawは`web_search`プロバイダーとしてPerplexity Search APIをサポートしている。
`title`、`url`、`snippet`フィールドを含む構造化された結果を返す。

互換性のため、OpenClawはレガシーのPerplexity Sonar/OpenRouterセットアップもサポートしている。
`OPENROUTER_API_KEY`を使用する場合、`plugins.entries.perplexity.config.webSearch.apiKey`に`sk-or-...`キーを設定する場合、または`plugins.entries.perplexity.config.webSearch.baseUrl` / `model`を設定する場合、プロバイダーはchat-completionsパスに切り替わり、構造化されたSearch API結果の代わりに引用付きのAI合成回答を返す。

## Perplexity APIキーの取得

1. [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api)でPerplexityアカウントを作成する
2. ダッシュボードでAPIキーを生成する
3. キーを設定に保存するか、Gateway ゲートウェイの環境に`PERPLEXITY_API_KEY`を設定する。

## OpenRouter互換性

すでにPerplexity Sonar用にOpenRouterを使用していた場合は、`provider: "perplexity"`を維持し、Gateway ゲートウェイの環境に`OPENROUTER_API_KEY`を設定するか、`plugins.entries.perplexity.config.webSearch.apiKey`に`sk-or-...`キーを保存する。

オプションの互換性設定：

- `plugins.entries.perplexity.config.webSearch.baseUrl`
- `plugins.entries.perplexity.config.webSearch.model`

## 設定例

### ネイティブPerplexity Search API

```json5
{
  plugins: {
    entries: {
      perplexity: {
        config: {
          webSearch: {
            apiKey: "pplx-...",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "perplexity",
      },
    },
  },
}
```

### OpenRouter / Sonar互換性

```json5
{
  plugins: {
    entries: {
      perplexity: {
        config: {
          webSearch: {
            apiKey: "<openrouter-api-key>",
            baseUrl: "https://openrouter.ai/api/v1",
            model: "perplexity/sonar-pro",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "perplexity",
      },
    },
  },
}
```

## キーの設定場所

**設定経由：** `openclaw configure --section web`を実行する。キーは`~/.openclaw/openclaw.json`の`plugins.entries.perplexity.config.webSearch.apiKey`に保存される。
このフィールドはSecretRefオブジェクトも受け付ける。

**環境経由：** Gateway ゲートウェイのプロセス環境に`PERPLEXITY_API_KEY`または`OPENROUTER_API_KEY`を設定する。Gateway ゲートウェイインストールの場合は、`~/.openclaw/.env`（またはサービス環境）に記述する。[環境変数](/help/faq#env-vars-and-env-loading)を参照。

`provider: "perplexity"`が設定されていて、PerplexityキーのSecretRefが未解決で環境変数のフォールバックもない場合、起動/リロードは即座に失敗する。

## ツールパラメータ

これらのパラメータはネイティブPerplexity Search APIパスに適用される。

| パラメータ             | 説明                                                  |
| --------------------- | ----------------------------------------------------- |
| `query`               | 検索クエリ（必須）                                      |
| `count`               | 返す結果の数（1-10、デフォルト：5）                       |
| `country`             | 2文字のISO国コード（例：「US」、「DE」）                  |
| `language`            | ISO 639-1言語コード（例：「en」、「de」、「fr」）          |
| `freshness`           | 時間フィルター：`day`（24時間）、`week`、`month`、`year`  |
| `date_after`          | この日付以降に公開された結果のみ（YYYY-MM-DD）             |
| `date_before`         | この日付以前に公開された結果のみ（YYYY-MM-DD）             |
| `domain_filter`       | ドメイン許可リスト/拒否リスト配列（最大20）                |
| `max_tokens`          | 合計コンテンツ予算（デフォルト：25000、最大：1000000）      |
| `max_tokens_per_page` | ページごとのトークン制限（デフォルト：2048）                |

レガシーのSonar/OpenRouter互換性パスでは、`query`と`freshness`のみがサポートされる。
`country`、`language`、`date_after`、`date_before`、`domain_filter`、`max_tokens`、`max_tokens_per_page`などのSearch API専用フィルターは明示的なエラーを返す。

**例：**

```javascript
// 国と言語を指定した検索
await web_search({
  query: "renewable energy",
  country: "DE",
  language: "de",
});

// 最近の結果（過去1週間）
await web_search({
  query: "AI news",
  freshness: "week",
});

// 日付範囲検索
await web_search({
  query: "AI developments",
  date_after: "2024-01-01",
  date_before: "2024-06-30",
});

// ドメインフィルタリング（許可リスト）
await web_search({
  query: "climate research",
  domain_filter: ["nature.com", "science.org", ".edu"],
});

// ドメインフィルタリング（拒否リスト - 先頭に - を付ける）
await web_search({
  query: "product reviews",
  domain_filter: ["-reddit.com", "-pinterest.com"],
});

// より多くのコンテンツ抽出
await web_search({
  query: "detailed AI research",
  max_tokens: 50000,
  max_tokens_per_page: 4096,
});
```

### ドメインフィルタールール

- フィルターごとに最大20ドメイン
- 同一リクエスト内で許可リストと拒否リストを混在させることはできない
- 拒否リストエントリには`-`プレフィックスを使用する（例：`["-reddit.com"]`）

## 注意

- Perplexity Search APIは構造化されたWeb検索結果（`title`、`url`、`snippet`）を返す
- OpenRouterまたは明示的な`plugins.entries.perplexity.config.webSearch.baseUrl` / `model`の指定により、Perplexityは互換性のためにSonarのchat completionsに切り替わる
- 結果はデフォルトで15分間キャッシュされる（`cacheTtlMinutes`で設定可能）

完全なweb_search設定については[Webツール](/tools/web)を参照。
詳細については[Perplexity Search APIドキュメント](https://docs.perplexity.ai/docs/search/quickstart)を参照。
