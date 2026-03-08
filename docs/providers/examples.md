---
summary: "Copy-paste configuration examples for popular model providers"
read_when:
  - You want to quickly configure a new provider
  - You need working config snippets for reference
title: "Provider Configuration Examples"
---

# Provider Configuration Examples

Quick reference for common provider configurations. Copy, paste, and customize.

## Anthropic (Claude)

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6" },
    },
  },
}
```

Or use OAuth (setup-token):
```bash
openclaw models auth login --provider anthropic --set-default
```

## OpenAI

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.2" },
    },
  },
}
```

## Google Gemini

```json5
{
  env: { GEMINI_API_KEY: "..." },
  agents: {
    defaults: {
      model: { primary: "google/gemini-3-pro-preview" },
    },
  },
}
```

## Moonshot AI (Kimi)

```json5
{
  env: { MOONSHOT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2.5" },
    },
  },
  models: {
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
      },
    },
  },
}
```

## Ollama (Local)

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/llama3.2" },
    },
  },
  models: {
    providers: {
      ollama: {
        baseUrl: "http://localhost:11434",
      },
    },
  },
}
```

## OpenRouter

```json5
{
  env: { OPENROUTER_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-3.5-sonnet" },
    },
  },
  models: {
    providers: {
      openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "${OPENROUTER_API_KEY}",
      },
    },
  },
}
```

## Multiple Providers (with fallback)

```json5
{
  env: {
    ANTHROPIC_API_KEY: "sk-ant-...",
    OPENAI_API_KEY: "sk-...",
    MOONSHOT_API_KEY: "sk-...",
  },
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Claude Opus" },
        "openai/gpt-5.2": { alias: "GPT" },
        "moonshot/kimi-k2.5": { alias: "Kimi" },
      },
    },
  },
  models: {
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
      },
    },
  },
}
```

## Environment Variables Only

For built-in providers (Anthropic, OpenAI, Google), you can use minimal config:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export GEMINI_API_KEY="..."
```

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6" },
    },
  },
}
```

---

See [Model Providers](/concepts/model-providers) for full configuration options and all supported providers.
