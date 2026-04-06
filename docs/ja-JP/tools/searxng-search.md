---
read_when:
    - セルフホスト型のウェブ検索プロバイダーを使用したい場合
    - SearXNG を web_search に使用したい場合
    - プライバシー重視またはエアギャップ環境の検索オプションが必要な場合
summary: SearXNG ウェブ検索 -- セルフホスト型、キー不要のメタ検索プロバイダー
title: SearXNG Search
x-i18n:
    generated_at: "2026-04-02T07:56:40Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: d589af17629690867faa26fa6446c8c156906849b65ece08ceeb3361f0d0a7f1
    source_path: tools/searxng-search.md
    workflow: 15
---

# SearXNG Search

OpenClaw は [SearXNG](https://docs.searxng.org/) を**セルフホスト型、キー不要**の `web_search` プロバイダーとしてサポートしています。SearXNG は Google、Bing、DuckDuckGo などのソースから結果を集約するオープンソースのメタ検索エンジンです。

利点：

- **無料で無制限** -- API キーや商用サブスクリプションが不要
- **プライバシー / エアギャップ** -- クエリがネットワーク外に出ない
- **どこでも動作** -- 商用検索 API の地域制限がない

## セットアップ

<Steps>
  <Step title="SearXNG インスタンスを実行する">
    ```bash
    docker run -d -p 8888:8080 searxng/searxng
    ```

    または、アクセス可能な既存の SearXNG デプロイメントを使用してください。本番環境のセットアップについては [SearXNG ドキュメント](https://docs.searxng.org/)を参照してください。

  </Step>
  <Step title="設定する">
    ```bash
    openclaw configure --section web
    # プロバイダーとして "searxng" を選択
    ```

    または環境変数を設定して自動検出に任せます：

    ```bash
    export SEARXNG_BASE_URL="http://localhost:8888"
    ```

  </Step>
</Steps>

## 設定

```json5
{
  tools: {
    web: {
      search: {
        provider: "searxng",
      },
    },
  },
}
```

SearXNG インスタンスのプラグインレベル設定：

```json5
{
  plugins: {
    entries: {
      searxng: {
        config: {
          webSearch: {
            baseUrl: "http://localhost:8888",
            categories: "general,news", // 任意
            language: "en", // 任意
          },
        },
      },
    },
  },
}
```

`baseUrl` フィールドは SecretRef オブジェクトも受け付けます。

## 環境変数

設定の代わりに `SEARXNG_BASE_URL` を設定できます：

```bash
export SEARXNG_BASE_URL="http://localhost:8888"
```

`SEARXNG_BASE_URL` が設定されており、明示的なプロバイダーが設定されていない場合、自動検出は SearXNG を自動的に選択します（最も低い優先度 -- キーを持つ API ベースのプロバイダーが先に優先されます）。

## プラグイン設定リファレンス

| フィールド   | 説明                                                               |
| ------------ | ------------------------------------------------------------------ |
| `baseUrl`    | SearXNG インスタンスのベース URL（必須）                           |
| `categories` | `general`、`news`、`science` などのカンマ区切りカテゴリ            |
| `language`   | `en`、`de`、`fr` などの結果の言語コード                            |

## 注意事項

- **JSON API** -- HTML スクレイピングではなく、SearXNG のネイティブ `format=json` エンドポイントを使用
- **API キー不要** -- あらゆる SearXNG インスタンスでそのまま動作
- **自動検出の順序** -- SearXNG は自動検出で最後にチェックされ（順序 200）、キーを持つ API ベースのプロバイダーが SearXNG より優先され、SearXNG は DuckDuckGo（順序 100）の後に位置する
- **セルフホスト** -- インスタンス、クエリ、上流の検索エンジンを自分で管理できる
- **カテゴリ**は未設定の場合、デフォルトで `general` になる

<Tip>
  SearXNG の JSON API を動作させるには、SearXNG インスタンスの `settings.yml` の `search.formats` で `json` フォーマットが有効になっていることを確認してください。
</Tip>

## 関連情報

- [ウェブ検索の概要](/tools/web) -- すべてのプロバイダーと自動検出
- [DuckDuckGo Search](/tools/duckduckgo-search) -- もう一つのキー不要フォールバック
- [Brave Search](/tools/brave-search) -- 無料枠付きの構造化された検索結果
