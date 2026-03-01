---
summary: "web_fetch向けFirecrawlフォールバック（ボット対策 + キャッシュ抽出）"
read_when:
  - Firecrawlバックのウェブ抽出が必要な場合
  - Firecrawl APIキーが必要な場合
  - web_fetchのボット対策抽出が必要な場合
title: "Firecrawl"
---

# Firecrawl

OpenClawは `web_fetch` のフォールバック抽出器として **Firecrawl** を使用できます。これはボット回避とキャッシュをサポートするホスト型コンテンツ抽出サービスであり、JSが多いサイトや平文HTTPフェッチをブロックするページに役立ちます。

## APIキーを取得する

1. Firecrawlアカウントを作成してAPIキーを生成します。
2. コンフィグに保存するか、Gateway環境で `FIRECRAWL_API_KEY` を設定します。

## Firecrawlを設定する

```json5
{
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

注意事項:

- `firecrawl.enabled` はAPIキーが存在する場合、デフォルトでtrueになります。
- `maxAgeMs` はキャッシュされた結果がどれくらい古くても良いかを制御します（ms）。デフォルトは2日間です。

## ステルス / ボット回避

Firecrawlはボット回避のための**プロキシモード**パラメーターを公開しています（`basic`、`stealth`、または `auto`）。
OpenClawはFirecrawlリクエストに常に `proxy: "auto"` と `storeInCache: true` を使用します。
プロキシが省略された場合、Firecrawlはデフォルトで `auto` になります。`auto` は基本的な試みが失敗した場合にステルスプロキシで再試行します。これはbasicのみのスクレイピングよりも多くのクレジットを使用する場合があります。

## `web_fetch` がFirecrawlを使用する方法

`web_fetch` の抽出順序:

1. Readability（ローカル）
2. Firecrawl（設定されている場合）
3. 基本的なHTMLクリーンアップ（最終フォールバック）

完全なウェブツールのセットアップについては [Webツール](/tools/web) を参照してください。
