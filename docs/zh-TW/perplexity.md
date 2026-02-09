---
summary: "用於 web_search 的 Perplexity Sonar 設定"
read_when:
  - 你想要使用 Perplexity Sonar 進行網頁搜尋
  - 你需要 PERPLEXITY_API_KEY 或 OpenRouter 設定
title: "Perplexity Sonar"
---

# Perplexity Sonar

OpenClaw 可將 Perplexity Sonar 用於 `web_search` 工具。你可以透過 Perplexity 的直接 API 連線，或經由 OpenRouter。 You can connect
through Perplexity’s direct API or via OpenRouter.

## API 選項

### Perplexity（直接）

- Base URL： [https://api.perplexity.ai](https://api.perplexity.ai)
- 環境變數： `PERPLEXITY_API_KEY`

### OpenRouter（替代方案）

- Base URL： [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- 環境變數： `OPENROUTER_API_KEY`
- 支援預付／加密貨幣點數。

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

如果同時設定 `PERPLEXITY_API_KEY` 與 `OPENROUTER_API_KEY`，請設定
`tools.web.search.perplexity.baseUrl`（或 `tools.web.search.perplexity.apiKey`）
以進行消歧。

如果未設定 base URL，OpenClaw 會依 API 金鑰來源選擇預設值：

- `PERPLEXITY_API_KEY` 或 `pplx-...` → 直接 Perplexity（`https://api.perplexity.ai`）
- `OPENROUTER_API_KEY` 或 `sk-or-...` → OpenRouter（`https://openrouter.ai/api/v1`）
- 未知的金鑰格式 → OpenRouter（安全的備援）

## 模型

- `perplexity/sonar` — 具備網頁搜尋的快速 Q&A
- `perplexity/sonar-pro`（預設）— 多步推理 + 網頁搜尋
- `perplexity/sonar-reasoning-pro` — 深度研究

請參閱 [Web tools](/tools/web) 以取得完整的 web_search 設定。
