---
read_when:
    - web_search に Brave Search を使用したいとき
    - BRAVE_API_KEY やプランの詳細が必要なとき
summary: web_search 用の Brave Search API セットアップ
title: Brave Search（レガシーパス）
x-i18n:
    generated_at: "2026-04-02T07:31:11Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 3f1e385029f5b758f34b7e858a6812a95ca02370345b41a63ab84f7039c252d5
    source_path: brave-search.md
    workflow: 15
---

# Brave Search API

OpenClaw は Brave Search API を `web_search` プロバイダーとしてサポートしています。

## API キーの取得

1. [https://brave.com/search/api/](https://brave.com/search/api/) で Brave Search API アカウントを作成します。
2. ダッシュボードで **Search** プランを選択し、API キーを生成します。
3. キーを設定に保存するか、Gateway ゲートウェイの環境変数に `BRAVE_API_KEY` を設定します。

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

プロバイダー固有の Brave 検索設定は `plugins.entries.brave.config.webSearch.*` 配下に配置されるようになりました。
レガシーの `tools.web.search.apiKey` は互換性シムを通じて引き続き読み込まれますが、正規の設定パスではなくなりました。

## ツールパラメータ

| パラメータ    | 説明                                                                |
| ------------- | ------------------------------------------------------------------- |
| `query`       | 検索クエリ（必須）                                                  |
| `count`       | 返す結果の数（1〜10、デフォルト: 5）                                |
| `country`     | 2文字の ISO 国コード（例: "US"、"DE"）                              |
| `language`    | 検索結果の ISO 639-1 言語コード（例: "en"、"de"、"fr"）             |
| `ui_lang`     | UI 要素の ISO 言語コード                                            |
| `freshness`   | 期間フィルター: `day`（24時間）、`week`、`month`、または `year`      |
| `date_after`  | この日付以降に公開された結果のみ（YYYY-MM-DD）                      |
| `date_before` | この日付以前に公開された結果のみ（YYYY-MM-DD）                      |

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

// 日付範囲指定の検索
await web_search({
  query: "AI developments",
  date_after: "2024-01-01",
  date_before: "2024-06-30",
});
```

## 注意事項

- OpenClaw は Brave の **Search** プランを使用します。レガシーのサブスクリプション（例: 月2,000クエリのオリジナル無料プラン）をお持ちの場合、引き続き有効ですが、LLM Context やより高いレート制限などの新しい機能は含まれません。
- 各 Brave プランには**月額 \$5 の無料クレジット**（毎月更新）が含まれています。Search プランは1,000リクエストあたり \$5 のため、クレジットで月1,000クエリをカバーできます。予期しない課金を避けるために、Brave ダッシュボードで使用量の上限を設定してください。現在のプランについては [Brave API ポータル](https://brave.com/search/api/)を参照してください。
- Search プランには LLM Context エンドポイントと AI 推論権が含まれています。結果を保存してモデルのトレーニングやチューニングに使用するには、明示的なストレージ権を持つプランが必要です。Brave の[利用規約](https://api-dashboard.search.brave.com/terms-of-service)を参照してください。
- 結果はデフォルトで15分間キャッシュされます（`cacheTtlMinutes` で設定可能）。

完全な web_search 設定については [Web ツール](/tools/web)を参照してください。
