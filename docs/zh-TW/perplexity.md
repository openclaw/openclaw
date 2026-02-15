---
summary: "為 web_search 設定 Perplexity Sonar"
read_when:
  - 您想使用 Perplexity Sonar 進行網路搜尋
  - 您需要設定 PERPLEXITY_API_KEY 或 OpenRouter
title: "Perplexity Sonar"
---

# Perplexity Sonar

OpenClaw 可以使用 Perplexity Sonar 作為 `web_search` 工具。您可以透過 Perplexity 的直接 API 或經由 OpenRouter 連接。

## API 選項

### Perplexity (直接)

- 基礎 URL: [https://api.perplexity.ai](https://api.perplexity.ai)
- 環境變數: `PERPLEXITY_API_KEY`

### OpenRouter (替代方案)

- 基礎 URL: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- 環境變數: `OPENROUTER_API_KEY`
- 支援預付/加密貨幣額度。

## 設定範例

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

## 從 Brave 切換

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

如果 `PERPLEXITY_API_KEY` 和 `OPENROUTER_API_KEY` 都已設定，請設定
`tools.web.search.perplexity.baseUrl` (或 `tools.web.search.perplexity.apiKey`)
以消除歧義。

如果未設定基礎 URL，OpenClaw 會根據 API 金鑰來源選擇一個預設值：

- `PERPLEXITY_API_KEY` 或 `pplx-...` → 直接 Perplexity (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` 或 `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- 未知金鑰格式 → OpenRouter (安全回退)

## 模型

- `perplexity/sonar` — 帶有網路搜尋的快速問答
- `perplexity/sonar-pro` (預設) — 多步驟推理 + 網路搜尋
- `perplexity/sonar-reasoning-pro` — 深度研究

請參閱 [Web tools](/tools/web) 了解完整的 web_search 設定。
