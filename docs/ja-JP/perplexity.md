---
summary: "web_search 用の Perplexity Sonar セットアップ"
read_when:
  - Web 検索に Perplexity Sonar を使用したい場合
  - PERPLEXITY_API_KEY または OpenRouter のセットアップが必要な場合
title: "Perplexity Sonar"
---

# Perplexity Sonar

OpenClaw は `web_search` ツールに Perplexity Sonar を使用できます。Perplexity の直接 API または OpenRouter 経由で接続できます。

## API オプション

### Perplexity（直接）

- ベース URL: [https://api.perplexity.ai](https://api.perplexity.ai)
- 環境変数: `PERPLEXITY_API_KEY`

### OpenRouter（代替）

- ベース URL: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- 環境変数: `OPENROUTER_API_KEY`
- プリペイド/暗号クレジットをサポート。

## コンフィグ例

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## Brave から切り替える

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
        },
      },
    },
  },
}
```

`PERPLEXITY_API_KEY` と `OPENROUTER_API_KEY` の両方が設定されている場合、`tools.web.search.perplexity.baseUrl`（または `tools.web.search.perplexity.apiKey`）を設定して明確にしてください。

ベース URL が設定されていない場合、OpenClaw は API キーのソースに基づいてデフォルトを選択します:

- `PERPLEXITY_API_KEY` または `pplx-...` → 直接 Perplexity（`https://api.perplexity.ai`）
- `OPENROUTER_API_KEY` または `sk-or-...` → OpenRouter（`https://openrouter.ai/api/v1`）
- 不明なキーフォーマット → OpenRouter（安全なフォールバック）

## モデル

- `perplexity/sonar` — Web 検索付き高速 Q&A
- `perplexity/sonar-pro`（デフォルト）— マルチステップ推論 + Web 検索
- `perplexity/sonar-reasoning-pro` — 深いリサーチ

完全な web_search 設定については [Web ツール](/tools/web) を参照してください。
