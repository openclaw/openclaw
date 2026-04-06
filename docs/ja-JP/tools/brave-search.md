---
read_when:
    - web_searchにBrave Searchを使用したい
    - BRAVE_API_KEYやプランの詳細が必要
summary: web_searchのためのBrave Search APIセットアップ
title: Brave Search
x-i18n:
    generated_at: "2026-04-02T08:39:26Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: eac36c13baf5c514b699d56f321f0b4ab6f58adb093ce00ba234005ceb01538c
    source_path: tools/brave-search.md
    workflow: 15
---

# Brave Search API

OpenClawはBrave Search APIを `web_search` プロバイダーとしてサポートしています。

## APIキーの取得

1. [https://brave.com/search/api/](https://brave.com/search/api/) でBrave Search APIアカウントを作成します
2. ダッシュボードで**Search**プランを選択し、APIキーを生成します。
3. キーを設定に保存するか、Gateway ゲートウェイの環境に `BRAVE_API_KEY` を設定します。

## 設定例

```json5
{
  plugins: {
    entries: {
      brave: {
        config: {
          webSearch: {
            apiKey: "BRAVE_API_KEY_HERE",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "brave",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

Brave固有の検索設定は `plugins.entries.brave.config.webSearch.*` に配置されるようになりました。
レガシーの `tools.web.search.apiKey` は互換性シムを通じて引き続き読み込まれますが、正規の設定パスではなくなりました。

## ツールパラメータ

| パラメータ     | 説明                                                         |
| ------------- | ------------------------------------------------------------------- |
| `query`       | 検索クエリ（必須）                                             |
| `count`       | 返す結果の数（1-10、デフォルト: 5）                      |
| `country`     | 2文字のISO国コード（例: 「US」、「DE」）                        |
| `language`    | 検索結果のISO 639-1言語コード（例: 「en」、「de」、「fr」） |
| `ui_lang`     | UI要素のISO言語コード                                   |
| `freshness`   | 期間フィルター: `day`（24時間）、`week`、`month`、または `year`                |
| `date_after`  | この日付以降に公開された結果のみ（YYYY-MM-DD）                 |
| `date_before` | この日付以前に公開された結果のみ（YYYY-MM-DD）                |

**例:**

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

// 日付範囲を指定した検索
await web_search({
  query: "AI developments",
  date_after: "2024-01-01",
  date_before: "2024-06-30",
});
```

## 注意事項

- OpenClawはBraveの**Search**プランを使用します。レガシーサブスクリプション（例: 月2,000クエリの初期無料プラン）をお持ちの場合、引き続き有効ですが、LLM Contextや高いレート制限などの新機能は含まれません。
- 各Braveプランには**月額$5の無料クレジット**（更新あり）が含まれます。Searchプランは1,000リクエストあたり$5のため、クレジットで月1,000クエリをカバーできます。予期しない請求を避けるために、Braveダッシュボードで使用上限を設定してください。現在のプランについては[Brave APIポータル](https://brave.com/search/api/)を参照してください。
- SearchプランにはLLM ContextエンドポイントとAI推論権が含まれます。結果を保存してモデルのトレーニングやチューニングに使用するには、明示的なストレージ権を持つプランが必要です。Braveの[利用規約](https://api-dashboard.search.brave.com/terms-of-service)を参照してください。
- 結果はデフォルトで15分間キャッシュされます（`cacheTtlMinutes` で設定可能）。

## 関連

- [Web Search概要](/tools/web) -- すべてのプロバイダーと自動検出
- [Perplexity Search](/tools/perplexity-search) -- ドメインフィルタリング付きの構造化された結果
- [Exa Search](/tools/exa-search) -- コンテンツ抽出付きのニューラル検索
