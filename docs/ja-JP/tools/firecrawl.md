---
read_when:
    - Firecrawl を利用したウェブ抽出を行いたい場合
    - Firecrawl API キーが必要な場合
    - Firecrawl を web_search プロバイダーとして使いたい場合
    - web_fetch でアンチボット抽出を行いたい場合
summary: Firecrawl の検索、スクレイピング、および web_fetch フォールバック
title: Firecrawl
x-i18n:
    generated_at: "2026-04-02T07:55:51Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: b110990d58802cedc6e0fc1f704b29c1f1bddd9206ca45013c5ad76fcc0d97ad
    source_path: tools/firecrawl.md
    workflow: 15
---

# Firecrawl

OpenClaw は **Firecrawl** を3つの方法で利用できます：

- `web_search` プロバイダーとして
- 明示的なプラグインツールとして：`firecrawl_search` および `firecrawl_scrape`
- `web_fetch` のフォールバック抽出エンジンとして

Firecrawl はボット回避やキャッシュ機能をサポートするホスト型の抽出・検索サービスで、
JS を多用するサイトや通常の HTTP フェッチをブロックするページに役立ちます。

## API キーの取得

1. Firecrawl アカウントを作成し、API キーを生成します。
2. 設定に保存するか、Gateway ゲートウェイの環境変数に `FIRECRAWL_API_KEY` を設定します。

## Firecrawl 検索の設定

```json5
{
  tools: {
    web: {
      search: {
        provider: "firecrawl",
      },
    },
  },
  plugins: {
    entries: {
      firecrawl: {
        enabled: true,
        config: {
          webSearch: {
            apiKey: "FIRECRAWL_API_KEY_HERE",
            baseUrl: "https://api.firecrawl.dev",
          },
        },
      },
    },
  },
}
```

注意事項：

- オンボーディングまたは `openclaw configure --section web` で Firecrawl を選択すると、バンドルされた Firecrawl プラグインが自動的に有効化されます。
- Firecrawl を使った `web_search` は `query` と `count` をサポートしています。
- `sources`、`categories`、結果のスクレイピングなど Firecrawl 固有の制御を行うには、`firecrawl_search` を使用してください。

## Firecrawl スクレイピング + web_fetch フォールバックの設定

```json5
{
  plugins: {
    entries: {
      firecrawl: {
        enabled: true,
      },
    },
  },
  tools: {
    web: {
      fetch: {
        firecrawl: {
          apiKey: "FIRECRAWL_API_KEY_HERE",
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 172800000,
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

注意事項：

- `firecrawl.enabled` は明示的に `false` に設定しない限り、デフォルトで `true` です。
- Firecrawl フォールバックの試行は、API キーが利用可能な場合（`tools.web.fetch.firecrawl.apiKey` または `FIRECRAWL_API_KEY`）にのみ実行されます。
- `maxAgeMs` はキャッシュされた結果の最大有効期間（ミリ秒）を制御します。デフォルトは2日間です。

`firecrawl_scrape` は同じ `tools.web.fetch.firecrawl.*` 設定および環境変数を再利用します。

## Firecrawl プラグインツール

### `firecrawl_search`

汎用的な `web_search` ではなく、Firecrawl 固有の検索制御を行いたい場合に使用します。

主要パラメータ：

- `query`
- `count`
- `sources`
- `categories`
- `scrapeResults`
- `timeoutSeconds`

### `firecrawl_scrape`

通常の `web_fetch` では対応が難しい、JS を多用するページやボット保護されたページに使用します。

主要パラメータ：

- `url`
- `extractMode`
- `maxChars`
- `onlyMainContent`
- `maxAgeMs`
- `proxy`
- `storeInCache`
- `timeoutSeconds`

## ステルス / ボット回避

Firecrawl はボット回避用の **proxy モード** パラメータ（`basic`、`stealth`、または `auto`）を公開しています。
OpenClaw は Firecrawl リクエストに対して常に `proxy: "auto"` と `storeInCache: true` を使用します。
proxy を省略した場合、Firecrawl のデフォルトは `auto` です。`auto` は basic の試行が失敗した場合にステルスプロキシでリトライします。これにより basic のみのスクレイピングよりも多くのクレジットを消費する場合があります。

## `web_fetch` での Firecrawl の利用方法

`web_fetch` の抽出順序：

1. Readability（ローカル）
2. Firecrawl（設定されている場合）
3. 基本的な HTML クリーンアップ（最終フォールバック）

## 関連項目

- [ウェブ検索の概要](/tools/web) -- すべてのプロバイダーと自動検出
- [Web Fetch](/tools/web-fetch) -- Firecrawl フォールバック付き web_fetch ツール
- [Tavily](/tools/tavily) -- 検索 + 抽出ツール
