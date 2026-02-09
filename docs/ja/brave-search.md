---
summary: "web_search 用の Brave Search API のセットアップ"
read_when:
  - web_search に Brave Search を使用したい場合
  - BRAVE_API_KEY またはプランの詳細が必要な場合
title: "Brave Search"
---

# Brave Search API

OpenClaw は、`web_search` のデフォルトプロバイダーとして Brave Search を使用します。

## API キーの取得

1. [https://brave.com/search/api/](https://brave.com/search/api/) で Brave Search API アカウントを作成します。
2. ダッシュボードで **Data for Search** プランを選択し、API キーを生成します。
3. キーを設定（推奨）に保存するか、Gateway の環境で `BRAVE_API_KEY` を設定します。

## 設定例

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

## 注記

- Data for AI プランは `web_search` と **互換性がありません**。
- Brave は無料枠と有料プランを提供しています。現在の制限については Brave API ポータルを確認してください。

web_search の完全な設定については、[Web tools](/tools/web) を参照してください。
