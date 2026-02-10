---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Web search + fetch tools (Brave Search API, Perplexity direct/OpenRouter)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to enable web_search or web_fetch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need Brave Search API key setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to use Perplexity Sonar for web search（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Web Tools"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Web tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw ships two lightweight web tools:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `web_search` — Search the web via Brave Search API (default) or Perplexity Sonar (direct or via OpenRouter).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `web_fetch` — HTTP fetch + readable extraction (HTML → markdown/text).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These are **not** browser automation. For JS-heavy sites or logins, use the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Browser tool](/tools/browser).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How it works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `web_search` calls your configured provider and returns results.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - **Brave** (default): returns structured results (title, URL, snippet).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - **Perplexity**: returns AI-synthesized answers with citations from real-time web search.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Results are cached by query for 15 minutes (configurable).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `web_fetch` does a plain HTTP GET and extracts readable content（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (HTML → markdown/text). It does **not** execute JavaScript.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `web_fetch` is enabled by default (unless explicitly disabled).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Choosing a search provider（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Provider            | Pros                                         | Cons                                     | API Key                                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------- | -------------------------------------------- | ---------------------------------------- | -------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Brave** (default) | Fast, structured results, free tier          | Traditional search results               | `BRAVE_API_KEY`                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Perplexity**      | AI-synthesized answers, citations, real-time | Requires Perplexity or OpenRouter access | `OPENROUTER_API_KEY` or `PERPLEXITY_API_KEY` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Brave Search setup](/brave-search) and [Perplexity Sonar](/perplexity) for provider-specific details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set the provider in config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    web: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      search: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        provider: "brave", // or "perplexity"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example: switch to Perplexity Sonar (direct API):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
## Getting a Brave API key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create a Brave Search API account at [https://brave.com/search/api/](https://brave.com/search/api/)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. In the dashboard, choose the **Data for Search** plan (not “Data for AI”) and generate an API key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Run `openclaw configure --section web` to store the key in config (recommended), or set `BRAVE_API_KEY` in your environment.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Brave provides a free tier plus paid plans; check the Brave API portal for the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
current limits and pricing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Where to set the key (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Recommended:** run `openclaw configure --section web`. It stores the key in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`~/.openclaw/openclaw.json` under `tools.web.search.apiKey`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Environment alternative:** set `BRAVE_API_KEY` in the Gateway process（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
environment. For a gateway install, put it in `~/.openclaw/.env` (or your（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
service environment). See [Env vars](/help/faq#how-does-openclaw-load-environment-variables).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Using Perplexity (direct or via OpenRouter)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Perplexity Sonar models have built-in web search capabilities and return AI-synthesized（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
answers with citations. You can use them via OpenRouter (no credit card required - supports（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
crypto/prepaid).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Getting an OpenRouter API key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create an account at [https://openrouter.ai/](https://openrouter.ai/)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Add credits (supports crypto, prepaid, or credit card)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Generate an API key in your account settings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Setting up Perplexity search（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    web: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      search: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        provider: "perplexity",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        perplexity: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          // API key (optional if OPENROUTER_API_KEY or PERPLEXITY_API_KEY is set)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          apiKey: "sk-or-v1-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          // Base URL (key-aware default if omitted)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          baseUrl: "https://openrouter.ai/api/v1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          // Model (defaults to perplexity/sonar-pro)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          model: "perplexity/sonar-pro",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Environment alternative:** set `OPENROUTER_API_KEY` or `PERPLEXITY_API_KEY` in the Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
environment. For a gateway install, put it in `~/.openclaw/.env`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If no base URL is set, OpenClaw chooses a default based on the API key source:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `PERPLEXITY_API_KEY` or `pplx-...` → `https://api.perplexity.ai`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENROUTER_API_KEY` or `sk-or-...` → `https://openrouter.ai/api/v1`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Unknown key formats → OpenRouter (safe fallback)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Available Perplexity models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Model                            | Description                          | Best for          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------------------------------- | ------------------------------------ | ----------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `perplexity/sonar`               | Fast Q&A with web search             | Quick lookups     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `perplexity/sonar-pro` (default) | Multi-step reasoning with web search | Complex questions |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `perplexity/sonar-reasoning-pro` | Chain-of-thought analysis            | Deep research     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## web_search（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Search the web using your configured provider.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Requirements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.web.search.enabled` must not be `false` (default: enabled)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- API key for your chosen provider:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - **Brave**: `BRAVE_API_KEY` or `tools.web.search.apiKey`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - **Perplexity**: `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY`, or `tools.web.search.perplexity.apiKey`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    web: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      search: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "BRAVE_API_KEY_HERE", // optional if BRAVE_API_KEY is set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxResults: 5,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        timeoutSeconds: 30,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        cacheTtlMinutes: 15,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tool parameters（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `query` (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `count` (1–10; default from config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `country` (optional): 2-letter country code for region-specific results (e.g., "DE", "US", "ALL"). If omitted, Brave chooses its default region.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `search_lang` (optional): ISO language code for search results (e.g., "de", "en", "fr")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ui_lang` (optional): ISO language code for UI elements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `freshness` (optional, Brave only): filter by discovery time (`pd`, `pw`, `pm`, `py`, or `YYYY-MM-DDtoYYYY-MM-DD`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Examples:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```javascript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// German-specific search（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
await web_search({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  query: "TV online schauen",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  count: 10,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  country: "DE",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  search_lang: "de",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
});（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// French search with French UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
await web_search({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  query: "actualités",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  country: "FR",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  search_lang: "fr",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ui_lang: "fr",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
});（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// Recent results (past week)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
await web_search({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  query: "TMBG interview",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  freshness: "pw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
});（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## web_fetch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fetch a URL and extract readable content.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### web_fetch requirements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.web.fetch.enabled` must not be `false` (default: enabled)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional Firecrawl fallback: set `tools.web.fetch.firecrawl.apiKey` or `FIRECRAWL_API_KEY`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### web_fetch config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    web: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      fetch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxChars: 50000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxCharsCap: 50000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        timeoutSeconds: 30,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        cacheTtlMinutes: 15,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxRedirects: 3,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        readability: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        firecrawl: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          apiKey: "FIRECRAWL_API_KEY_HERE", // optional if FIRECRAWL_API_KEY is set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          baseUrl: "https://api.firecrawl.dev",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          onlyMainContent: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          maxAgeMs: 86400000, // ms (1 day)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          timeoutSeconds: 60,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### web_fetch tool parameters（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `url` (required, http/https only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `extractMode` (`markdown` | `text`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `maxChars` (truncate long pages)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `web_fetch` uses Readability (main-content extraction) first, then Firecrawl (if configured). If both fail, the tool returns an error.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Firecrawl requests use bot-circumvention mode and cache results by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `web_fetch` sends a Chrome-like User-Agent and `Accept-Language` by default; override `userAgent` if needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `web_fetch` blocks private/internal hostnames and re-checks redirects (limit with `maxRedirects`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `maxChars` is clamped to `tools.web.fetch.maxCharsCap`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `web_fetch` is best-effort extraction; some sites will need the browser tool.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- See [Firecrawl](/tools/firecrawl) for key setup and service details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Responses are cached (default 15 minutes) to reduce repeated fetches.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you use tool profiles/allowlists, add `web_search`/`web_fetch` or `group:web`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the Brave key is missing, `web_search` returns a short setup hint with a docs link.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
