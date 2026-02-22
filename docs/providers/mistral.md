---
summary: "Use Mistral AI models in OpenClaw"
read_when:
  - You want Mistral models in OpenClaw
  - You need Mistral setup guidance
title: "Mistral AI"
---

# Mistral AI

Mistral AI is a European AI company building powerful language models. Their models include **Mistral Large**, **Mistral Medium**, **Mistral Small**, **Codestral** (code-focused), and **Ministral** (edge-efficient).

Source: [Mistral AI](https://mistral.ai)

## Model overview

| Model | Context Window | Input Types | Best For |
|-------|----------------|-------------|----------|
| Mistral Large | 128K | text, image | Complex tasks, reasoning |
| Mistral Medium | 128K | text | General-purpose |
| Mistral Small | 128K | text | Fast, cost-effective |
| Codestral | 256K | text | Code generation |
| Ministral 8B | 128K | text | Edge deployment, fast |

## Pricing (per 1M tokens)

| Model | Input | Output |
|-------|-------|--------|
| Mistral Large | $2.00 | $6.00 |
| Mistral Medium | $0.40 | $1.20 |
| Mistral Small | $0.10 | $0.30 |
| Codestral | $0.30 | $0.90 |

## Setup

### Quick setup (API key)

Set the `MISTRAL_API_KEY` environment variable and the provider will be auto-configured:

```bash
export MISTRAL_API_KEY="your-api-key"
```

Or configure via CLI:

```bash
openclaw configure
# Select Model/auth
# Choose Custom provider
# Enter: mistral
```

### Configuration

```json5
{
  env: { MISTRAL_API_KEY: "your-api-key" },
  agents: { defaults: { model: { primary: "mistral/mistral-large-latest" } } },
  models: {
    mode: "merge",
    providers: {
      mistral: {
        baseUrl: "https://api.mistral.ai/v1",
        apiKey: "${MISTRAL_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "mistral-large-latest",
            name: "Mistral Large",
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 2.0, output: 6.0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
          {
            id: "mistral-medium-latest",
            name: "Mistral Medium",
            reasoning: false,
            input: ["text"],
            cost: { input: 0.4, output: 1.2, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
          {
            id: "mistral-small-latest",
            name: "Mistral Small",
            reasoning: false,
            input: ["text"],
            cost: { input: 0.1, output: 0.3, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
          {
            id: "codestral-latest",
            name: "Codestral",
            reasoning: false,
            input: ["text"],
            cost: { input: 0.3, output: 0.9, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "ministral-8b-latest",
            name: "Ministral 8B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0.1, output: 0.3, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### Mistral as fallback (Opus primary)

**Best for:** keep Opus 4.6 as primary, fail over to Mistral Large.

```json5
{
  env: { MISTRAL_API_KEY: "your-api-key" },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "mistral/mistral-large-latest": { alias: "mistral" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["mistral/mistral-large-latest"],
      },
    },
  },
}
```

## Model references

Use these model refs with `/model` or in config:

- `mistral/mistral-large-latest` - Mistral Large (most capable)
- `mistral/mistral-medium-latest` - Mistral Medium (balanced)
- `mistral/mistral-small-latest` - Mistral Small (fast, cheap)
- `mistral/codestral-latest` - Codestral (code-focused)
- `mistral/ministral-8b-latest` - Ministral 8B (edge-efficient)

## Switch models

```bash
# List available models
openclaw models list

# Switch to Mistral Large
openclaw models set mistral/mistral-large-latest

# Or use in chat
/model mistral/mistral-large-latest
```

## Configuration options

- `models.providers.mistral.baseUrl`: `https://api.mistral.ai/v1` (default)
- `models.providers.mistral.api`: `openai-completions` (Mistral uses OpenAI-compatible API)
- `models.providers.mistral.apiKey`: Mistral API key (`MISTRAL_API_KEY`)
- `models.providers.mistral.models`: define `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`
- `agents.defaults.models`: alias models you want in the allowlist
- `models.mode`: keep `merge` if you want to add Mistral alongside built-ins

## Notes

- Model refs are `mistral/<model>`.
- Mistral uses an OpenAI-compatible API (`openai-completions`).
- The provider is injected automatically when `MISTRAL_API_KEY` is set (or an auth profile exists).
- Mistral Large supports image input (vision).
- Codestral has a larger context window (256K) optimized for code.
- See [Model providers](/concepts/model-providers) for provider-wide rules.

## Troubleshooting

### "Unknown model: mistral/mistral-large-latest"

This means the **Mistral provider isn't configured**. Fix by:

- Setting `MISTRAL_API_KEY` environment variable, or
- Adding the `models.providers.mistral` block manually, or
- Creating a Mistral auth profile: `openclaw models auth paste-token --provider mistral`

Then recheck with:

```bash
openclaw models list
```

### Tool call issues

Mistral requires strict tool call IDs (alphanumeric, length 9). OpenClaw handles this automatically via transcript sanitization. If you see tool call errors, ensure you're using the latest OpenClaw version.

## Get your API key

1. Go to [Mistral AI Console](https://console.mistral.ai/)
2. Create an account or sign in
3. Navigate to API Keys
4. Create a new API key
5. Set it as `MISTRAL_API_KEY` in your environment or config
