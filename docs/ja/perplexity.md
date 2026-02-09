---
summary: "web_search 用の Perplexity Sonar セットアップ"
read_when:
  - Perplexity Sonar を web 検索に使用したい場合
  - PERPLEXITY_API_KEY または OpenRouter のセットアップが必要な場合
title: "Perplexity Sonar"
---

# Perplexity Sonar

OpenClaw は、`web_search` ツールで Perplexity Sonar を使用できます。Perplexity の直接 API、または OpenRouter 経由で接続できます。
は、Perplexityの直接APIまたはOpenRouter経由で接続できます。

## API オプション

### Perplexity（直接）

- ベース URL: [https://api.perplexity.ai](https://api.perplexity.ai)
- 環境変数: `PERPLEXITY_API_KEY`

### OpenRouter（代替）

- ベース URL: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- 環境変数: `OPENROUTER_API_KEY`
- プリペイド／暗号資産クレジットをサポートします。

## 設定例

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

## Brave からの切り替え

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

`PERPLEXITY_API_KEY` と `OPENROUTER_API_KEY` の両方が設定されている場合は、判別のために `tools.web.search.perplexity.baseUrl`（または `tools.web.search.perplexity.apiKey`）を設定してください。

ベース URL が設定されていない場合、OpenClaw は API キーの提供元に基づいて既定値を選択します。

- `PERPLEXITY_API_KEY` または `pplx-...` → 直接 Perplexity（`https://api.perplexity.ai`）
- `OPENROUTER_API_KEY` または `sk-or-...` → OpenRouter（`https://openrouter.ai/api/v1`）
- 不明なキー形式 → OpenRouter（安全なフォールバック）

## モデル

- `perplexity/sonar` — Web 検索付きの高速 Q&A
- `perplexity/sonar-pro`（既定）— マルチステップ推論 + Web 検索
- `perplexity/sonar-reasoning-pro` — 詳細なリサーチ

web_search の完全な設定については、[Web tools](/tools/web) を参照してください。
