# OpenClaw DeepSeek Provider

Official OpenClaw provider plugin for DeepSeek models and web search.

Select `tools.web.search.provider: "deepseek"` to search with any model. Search
uses `DEEPSEEK_API_KEY`, a plugin search key, or the configured model-provider key
while that provider and its models use DeepSeek's API; see the setup documentation
for credential precedence and query limits.

Install from OpenClaw:

```bash
openclaw plugins install @openclaw/deepseek-provider
openclaw gateway restart
```

See <https://docs.openclaw.ai/providers/deepseek> for setup and configuration.
