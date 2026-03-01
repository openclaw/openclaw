---
summary: "Use Qwen via OAuth (free tier) or DashScope API in OpenClaw"
read_when:
  - You want to use Qwen with OpenClaw
  - You want free-tier OAuth or paid DashScope API access
title: "Qwen"
---

# Qwen

Qwen offers two authentication paths in OpenClaw:

- **Option A: OAuth (free tier)** — Device-code flow for Qwen Coder and Qwen Vision (2,000 requests/day).
- **Option B: DashScope API** — API key for full Qwen model catalog (Qwen-Max, Qwen-Plus, Qwen-Turbo, etc.).

---

## Option A: OAuth (free tier)

**Best for:** free access to Qwen Coder and Qwen Vision with no API key.

### Enable the plugin

```bash
openclaw plugins enable qwen-portal-auth
```

Restart the Gateway after enabling.

### Authenticate

```bash
openclaw models auth login --provider qwen-portal --set-default
```

This runs the Qwen device-code OAuth flow and writes a provider entry to your
`models.json` (plus a `qwen` alias for quick switching).

### Model IDs (OAuth)

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Switch models with:

```bash
openclaw models set qwen-portal/coder-model
```

### Reuse Qwen Code CLI login

If you already logged in with the Qwen Code CLI, OpenClaw will sync credentials
from `~/.qwen/oauth_creds.json` when it loads the auth store. You still need a
`models.providers.qwen-portal` entry (use the login command above to create one).

---

## Option B: DashScope API (API key)

**Best for:** full Qwen model catalog, higher rate limits, and usage-based billing.

DashScope is Alibaba Cloud's API platform for Qwen models. It provides
OpenAI-compatible endpoints, so OpenClaw can use it via a custom provider.

### Prerequisites

1. An Alibaba Cloud account
2. Model Studio (DashScope) activated — [Model Studio console](https://bailian.console.alibabacloud.com/#/home)
3. API key from the [API-KEY page](https://bailian.console.alibabacloud.com/?apiKey=1#/api-key)

### Region selection

Choose the base URL for your region:

| Region                    | Base URL                                                 |
| ------------------------- | -------------------------------------------------------- |
| China (Beijing)           | `https://dashscope.aliyuncs.com/compatible-mode/v1`      |
| International (Singapore) | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| US (Virginia)             | `https://dashscope-us.aliyuncs.com/compatible-mode/v1`   |

### CLI setup (environment variable)

```bash
export DASHSCOPE_API_KEY="sk-..."
openclaw onboard
# Or add to ~/.openclaw/.env for daemon use
```

### Config snippet (DashScope API)

```json5
{
  env: { DASHSCOPE_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "dashscope/qwen-max" },
      models: {
        "dashscope/qwen-max": { alias: "Qwen Max" },
        "dashscope/qwen-plus": { alias: "Qwen Plus" },
        "dashscope/qwen-turbo": { alias: "Qwen Turbo" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      dashscope: {
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        apiKey: "${DASHSCOPE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "qwen-max",
            name: "Qwen Max",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
          {
            id: "qwen-plus",
            name: "Qwen Plus",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
          {
            id: "qwen-turbo",
            name: "Qwen Turbo",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
          {
            id: "qwen3-max",
            name: "Qwen3 Max",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
          {
            id: "qwen3.5-plus",
            name: "Qwen3.5 Plus",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

> **Note:** The model fields above (`contextWindow`, `maxTokens`, `cost`, etc.) are example values and may not be accurate. For authoritative specs, consult the [Alibaba Model Studio documentation](https://www.alibabacloud.com/help/en/model-studio/models). This config is intended as a template for adding models to your `openclaw.json`.

For International (Singapore), use:

```json5
baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
```

For US (Virginia), use:

```json5
baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1"
```

### Model IDs (DashScope)

Common model IDs (check [Alibaba Model Studio](https://www.alibabacloud.com/help/en/model-studio/models) for the latest):

- `qwen-max`, `qwen-max-latest`
- `qwen-plus`, `qwen-plus-latest`
- `qwen-turbo`, `qwen-turbo-latest`
- `qwen3-max`, `qwen3-max-preview`
- `qwen3.5-plus`, `qwen3.5-flash`
- `qwen3-coder-plus` (coding)
- `qwen3-8b`, `qwen3-14b`, `qwen3-32b` (open-source)

Model refs use `dashscope/<modelId>` (for example, `dashscope/qwen-max`).

### Non-interactive example

```bash
export DASHSCOPE_API_KEY="sk-..."
# Add provider via config, then:
openclaw models set dashscope/qwen-max
```

---

## Notes

- **OAuth:** Tokens auto-refresh; re-run the login command if refresh fails or access is revoked.
- **OAuth:** Default base URL: `https://portal.qwen.ai/v1` (override with
  `models.providers.qwen-portal.baseUrl` if Qwen provides a different endpoint).
- **DashScope:** API key is typically `sk-` prefixed; store in `~/.openclaw/.env` when the Gateway runs as a daemon.
- See [Model providers](/concepts/model-providers) for provider-wide rules.
