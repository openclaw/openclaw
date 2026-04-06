---
read_when:
    - ウェブ検索に Perplexity Search を使用したい場合
    - PERPLEXITY_API_KEY または OPENROUTER_API_KEY のセットアップが必要な場合
summary: web_search 向けの Perplexity Search API と Sonar/OpenRouter 互換性
title: Perplexity Search
x-i18n:
    generated_at: "2026-04-02T07:56:23Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: c63efe9e35c93f16171e1139d6eb11a04203bed5680e3e2c39c181e9cd2924fa
    source_path: tools/perplexity-search.md
    workflow: 15
---

# Perplexity Search API

OpenClaw は Perplexity Search API を `web_search` プロバイダーとしてサポートしています。
`title`、`url`、`snippet` フィールドを持つ構造化された結果を返します。

互換性のために、OpenClaw はレガシーの Perplexity Sonar/OpenRouter セットアップもサポートしています。
`OPENROUTER_API_KEY` を使用する場合、`plugins.entries.perplexity.config.webSearch.apiKey` に `sk-or-...` キーを設定する場合、または `plugins.entries.perplexity.config.webSearch.baseUrl` / `model` を設定する場合、プロバイダーはチャット補完パスに切り替わり、構造化された Search API 結果の代わりに引用付きの AI 合成回答を返します。

## Perplexity API キーの取得

1. [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api) で Perplexity アカウントを作成します
2. ダッシュボードで API キーを生成します
3. 設定にキーを保存するか、Gateway ゲートウェイの環境に `PERPLEXITY_API_KEY` を設定します。

## OpenRouter 互換性

OpenRouter 経由で Perplexity Sonar を既に使用していた場合は、`provider: "perplexity"` のままにして、Gateway ゲートウェイの環境に `OPENROUTER_API_KEY` を設定するか、`plugins.entries.perplexity.config.webSearch.apiKey` に `sk-or-...` キーを保存してください。

オプションの互換性設定：

- `plugins.entries.perplexity.config.webSearch.baseUrl`
- `plugins.entries.perplexity.config.webSearch.model`

## 設定例

### ネイティブ Perplexity Search API

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

### OpenRouter / Sonar 互換性

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

**設定経由：** `openclaw configure --section web` を実行します。キーは
`~/.openclaw/openclaw.json` の `plugins.entries.perplexity.config.webSearch.apiKey` に保存されます。
このフィールドは SecretRef オブジェクトも受け付けます。

**環境変数経由：** Gateway ゲートウェイのプロセス環境に `PERPLEXITY_API_KEY` または `OPENROUTER_API_KEY` を設定します。Gateway ゲートウェイのインストール環境では、`~/.openclaw/.env`（またはサービス環境）に記述してください。[環境変数](/help/faq#env-vars-and-env-loading)を参照してください。

`provider: "perplexity"` が設定されており、Perplexity キーの SecretRef が未解決で環境変数のフォールバックもない場合、起動/リロードは即座に失敗します。

## ツールパラメータ

これらのパラメータはネイティブ Perplexity Search API パスに適用されます。

| パラメータ             | 説明                                                  |
| --------------------- | ---------------------------------------------------- |
| `query`               | 検索クエリ（必須）                                     |
| `count`               | 返す結果の数（1〜10、デフォルト: 5）                     |
| `country`             | 2文字の ISO 国コード（例: "US"、"DE"）                  |
| `language`            | ISO 639-1 言語コード（例: "en"、"de"、"fr"）            |
| `freshness`           | 時間フィルター: `day`（24時間）、`week`、`month`、`year` |
| `date_after`          | この日付以降に公開された結果のみ（YYYY-MM-DD）           |
| `date_before`         | この日付以前に公開された結果のみ（YYYY-MM-DD）           |
| `domain_filter`       | ドメインの許可リスト/拒否リスト配列（最大20件）           |
| `max_tokens`          | コンテンツ合計予算（デフォルト: 25000、最大: 1000000）    |
| `max_tokens_per_page` | ページごとのトークン制限（デフォルト: 2048）              |

レガシーの Sonar/OpenRouter 互換パスでは、`query` と `freshness` のみサポートされます。
`country`、`language`、`date_after`、`date_before`、`domain_filter`、`max_tokens`、`max_tokens_per_page` などの Search API 専用フィルターは明示的なエラーを返します。

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

// ドメインフィルタリング（拒否リスト - プレフィックスに - を付ける）
await web_search({
  query: "product reviews",
  domain_filter: ["-reddit.com", "-pinterest.com"],
});

// より多くのコンテンツを抽出
await web_search({
  query: "detailed AI research",
  max_tokens: 50000,
  max_tokens_per_page: 4096,
});
```

### ドメインフィルターのルール

- フィルターごとに最大20ドメイン
- 同じリクエストで許可リストと拒否リストを混在させることはできません
- 拒否リストのエントリには `-` プレフィックスを使用します（例: `["-reddit.com"]`）

## 注意事項

- Perplexity Search API は構造化されたウェブ検索結果（`title`、`url`、`snippet`）を返します
- OpenRouter または明示的な `plugins.entries.perplexity.config.webSearch.baseUrl` / `model` の指定により、Perplexity は互換性のために Sonar チャット補完に切り替わります
- 結果はデフォルトで15分間キャッシュされます（`cacheTtlMinutes` で設定可能）

## 関連

- [ウェブ検索の概要](/tools/web) -- すべてのプロバイダーと自動検出
- [Perplexity Search API ドキュメント](https://docs.perplexity.ai/docs/search/quickstart) -- 公式 Perplexity ドキュメント
- [Brave Search](/tools/brave-search) -- 国/言語フィルター付きの構造化結果
- [Exa Search](/tools/exa-search) -- コンテンツ抽出付きのニューラル検索
