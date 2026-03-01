---
summary: "web_search 用の Brave Search API セットアップ"
read_when:
  - web_search に Brave Search を使用したい場合
  - BRAVE_API_KEY またはプランの詳細が必要な場合
title: "Brave Search"
---

# Brave Search API

OpenClaw は `web_search` のデフォルトプロバイダーとして Brave Search を使用します。

## API キーの取得

1. [https://brave.com/search/api/](https://brave.com/search/api/) で Brave Search API アカウントを作成します。
2. ダッシュボードで **Data for Search** プランを選択し、API キーを生成します。
3. キーをコンフィグに保存する（推奨）か、Gateway 環境で `BRAVE_API_KEY` を設定します。

## コンフィグ例

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

## メモ

- Data for AI プランは `web_search` と**互換性がありません**。
- Brave は無料ティアと有料プランを提供しています。現在の制限については Brave API ポータルを確認してください。

完全な web_search 設定については [Web ツール](/tools/web) を参照してください。
