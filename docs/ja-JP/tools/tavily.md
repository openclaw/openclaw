---
read_when:
    - Tavily を使ったウェブ検索を利用したい
    - Tavily の API キーが必要
    - Tavily を web_search プロバイダーとして使いたい
    - URL からコンテンツを抽出したい
summary: Tavily の検索および抽出ツール
title: Tavily
x-i18n:
    generated_at: "2026-04-02T07:57:09Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: db530cc101dc930611e4ca54e3d5972140f116bfe168adc939dc5752322d205e
    source_path: tools/tavily.md
    workflow: 15
---

# Tavily

OpenClaw は **Tavily** を2つの方法で使用できます:

- `web_search` プロバイダーとして
- 明示的なプラグインツールとして: `tavily_search` および `tavily_extract`

Tavily は AI アプリケーション向けに設計された検索 API で、LLM での利用に最適化された構造化された結果を返します。設定可能な検索深度、トピックフィルタリング、ドメインフィルター、AI 生成の回答要約、URL からのコンテンツ抽出（JavaScript レンダリングされたページを含む）をサポートしています。

## API キーの取得

1. [tavily.com](https://tavily.com/) で Tavily アカウントを作成します。
2. ダッシュボードで API キーを生成します。
3. 設定に保存するか、Gateway ゲートウェイ環境で `TAVILY_API_KEY` を設定します。

## Tavily 検索の設定

```json5
{
  plugins: {
    entries: {
      tavily: {
        enabled: true,
        config: {
          webSearch: {
            apiKey: "tvly-...", // TAVILY_API_KEY が設定済みの場合は省略可能
            baseUrl: "https://api.tavily.com",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "tavily",
      },
    },
  },
}
```

注意事項:

- オンボーディングまたは `openclaw configure --section web` で Tavily を選択すると、バンドルされた Tavily プラグインが自動的に有効になります。
- Tavily の設定は `plugins.entries.tavily.config.webSearch.*` 以下に保存します。
- Tavily を使用した `web_search` は `query` と `count`（最大20件の結果）をサポートします。
- `search_depth`、`topic`、`include_answer`、ドメインフィルターなど Tavily 固有の制御には `tavily_search` を使用してください。

## Tavily プラグインツール

### `tavily_search`

汎用的な `web_search` ではなく、Tavily 固有の検索制御を使用したい場合に使用します。

| パラメータ        | 説明                                                                  |
| ----------------- | --------------------------------------------------------------------- |
| `query`           | 検索クエリ文字列（400文字以内推奨）                                   |
| `search_depth`    | `basic`（デフォルト、バランス型）または `advanced`（最高精度、低速）   |
| `topic`           | `general`（デフォルト）、`news`（リアルタイム更新）、または `finance`  |
| `max_results`     | 結果の件数、1〜20（デフォルト: 5）                                    |
| `include_answer`  | AI 生成の回答要約を含める（デフォルト: false）                        |
| `time_range`      | 新しさでフィルター: `day`、`week`、`month`、または `year`             |
| `include_domains` | 結果を制限するドメインの配列                                          |
| `exclude_domains` | 結果から除外するドメインの配列                                        |

**検索深度:**

| 深度       | 速度   | 関連性 | 最適な用途                            |
| ---------- | ------ | ------ | ------------------------------------- |
| `basic`    | 高速   | 高     | 汎用クエリ（デフォルト）              |
| `advanced` | 低速   | 最高   | 精密検索、特定の事実、リサーチ        |

### `tavily_extract`

1つまたは複数の URL からクリーンなコンテンツを抽出する場合に使用します。JavaScript レンダリングされたページに対応し、対象を絞った抽出のためのクエリベースのチャンキングをサポートしています。

| パラメータ          | 説明                                                       |
| ------------------- | ---------------------------------------------------------- |
| `urls`              | 抽出する URL の配列（リクエストあたり1〜20件）             |
| `query`             | このクエリとの関連性で抽出チャンクを再ランク付け           |
| `extract_depth`     | `basic`（デフォルト、高速）または `advanced`（JS が多いページ向け） |
| `chunks_per_source` | URL あたりのチャンク数、1〜5（`query` が必要）             |
| `include_images`    | 結果に画像 URL を含める（デフォルト: false）               |

**抽出深度:**

| 深度       | 使用する場面                                |
| ---------- | ------------------------------------------- |
| `basic`    | シンプルなページ - まずこちらを試す         |
| `advanced` | JS レンダリングの SPA、動的コンテンツ、テーブル |

ヒント:

- リクエストあたり最大20件の URL。より大きなリストは複数回の呼び出しに分割してください。
- `query` + `chunks_per_source` を使用して、ページ全体ではなく関連するコンテンツのみを取得できます。
- まず `basic` を試し、コンテンツが欠落または不完全な場合は `advanced` にフォールバックしてください。

## 適切なツールの選択

| 必要な機能                               | ツール           |
| ---------------------------------------- | ---------------- |
| 特別なオプション不要の簡易ウェブ検索     | `web_search`     |
| 深度、トピック、AI 回答付きの検索        | `tavily_search`  |
| 特定の URL からのコンテンツ抽出          | `tavily_extract` |

## 関連項目

- [ウェブ検索の概要](/tools/web) -- すべてのプロバイダーと自動検出
- [Firecrawl](/tools/firecrawl) -- コンテンツ抽出付きの検索とスクレイピング
- [Exa Search](/tools/exa-search) -- コンテンツ抽出付きのニューラル検索
