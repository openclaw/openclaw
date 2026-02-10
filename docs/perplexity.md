---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Perplexity Sonar setup for web_search"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to use Perplexity Sonar for web search（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need PERPLEXITY_API_KEY or OpenRouter setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Perplexity Sonar"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Perplexity Sonar（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can use Perplexity Sonar for the `web_search` tool. You can connect（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
through Perplexity’s direct API or via OpenRouter.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## API options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Perplexity (direct)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Base URL: [https://api.perplexity.ai](https://api.perplexity.ai)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Environment variable: `PERPLEXITY_API_KEY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### OpenRouter (alternative)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Base URL: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Environment variable: `OPENROUTER_API_KEY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Supports prepaid/crypto credits.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    web: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      search: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        provider: "perplexity",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        perplexity: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          apiKey: "pplx-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          baseUrl: "https://api.perplexity.ai",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          model: "perplexity/sonar-pro",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Switching from Brave（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    web: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      search: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        provider: "perplexity",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        perplexity: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          apiKey: "pplx-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          baseUrl: "https://api.perplexity.ai",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If both `PERPLEXITY_API_KEY` and `OPENROUTER_API_KEY` are set, set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`tools.web.search.perplexity.baseUrl` (or `tools.web.search.perplexity.apiKey`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to disambiguate.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If no base URL is set, OpenClaw chooses a default based on the API key source:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `PERPLEXITY_API_KEY` or `pplx-...` → direct Perplexity (`https://api.perplexity.ai`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENROUTER_API_KEY` or `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Unknown key formats → OpenRouter (safe fallback)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `perplexity/sonar` — fast Q&A with web search（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `perplexity/sonar-pro` (default) — multi-step reasoning + web search（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `perplexity/sonar-reasoning-pro` — deep research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Web tools](/tools/web) for the full web_search configuration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
