# OpenClaw DeepSeek Provider

Official OpenClaw provider plugin for DeepSeek models, web search, and optional web fetch.

Select `tools.web.search.provider: "deepseek"` to search with any model. Search
uses `DEEPSEEK_API_KEY`, a plugin search key, or a configured model-provider key;
see the setup documentation for credential precedence and query limits.

Select `tools.web.fetch.provider: "deepseek"` to use DeepSeek's Fetch API as the
`web_fetch` fallback. Local extraction remains first; configuring DeepSeek for
models or search alone does not enable paid fetches. Fetch reuses the search
credential and sends the requested URL to DeepSeek.

Install from OpenClaw:

```bash
openclaw plugins install @openclaw/deepseek-provider
openclaw gateway restart
```

See <https://docs.openclaw.ai/providers/deepseek> for setup and configuration.
