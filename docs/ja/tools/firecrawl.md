---
summary: "web_fetch 向けの Firecrawl フォールバック（アンチボット＋キャッシュ抽出）"
read_when:
  - Firecrawl を利用した web 抽出を行いたい場合
  - Firecrawl API キーが必要な場合
  - web_fetch に対してアンチボット抽出が必要な場合
title: "Firecrawl"
x-i18n:
  source_path: tools/firecrawl.md
  source_hash: 08a7ad45b41af412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:23:26Z
---

# Firecrawl

OpenClaw は、`web_fetch` のフォールバック抽出器として **Firecrawl** を使用できます。これはホスト型の
コンテンツ抽出サービスで、ボット回避とキャッシュをサポートしており、JS を多用するサイトや通常の HTTP フェッチをブロックするページで有効です。

## API キーを取得する

1. Firecrawl のアカウントを作成し、API キーを生成します。
2. 設定に保存するか、ゲートウェイ環境で `FIRECRAWL_API_KEY` を設定します。

## Firecrawl を設定する

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

注記:

- `firecrawl.enabled` は、API キーが存在する場合にデフォルトで true になります。
- `maxAgeMs` は、キャッシュされた結果の許容経過時間（ms）を制御します。デフォルトは 2 日です。

## ステルス／ボット回避

Firecrawl は、ボット回避のための **プロキシモード** パラメーター（`basic`、`stealth`、または `auto`）を公開しています。
OpenClaw は Firecrawl のリクエストに対して、常に `proxy: "auto"` に `storeInCache: true` を組み合わせて使用します。
プロキシが省略された場合、Firecrawl はデフォルトで `auto` を使用します。`auto` は、基本的な試行が失敗した場合にステルスプロキシで再試行しますが、基本のみのスクレイピングよりも多くのクレジットを消費する可能性があります。

## `web_fetch` における Firecrawl の使用方法

`web_fetch` の抽出順序:

1. Readability（ローカル）
2. Firecrawl（設定されている場合）
3. 基本的な HTML クリーンアップ（最終フォールバック）

Web ツールの完全なセットアップについては、[Web tools](/tools/web) を参照してください。
