---
summary: "Run OpenClaw with Ollama (local LLM runtime)"
read_when:
  - You want to run OpenClaw with local models via Ollama
  - You need Ollama setup and configuration guidance
title: "Ollama"
---

# Ollama

Ollama is a local LLM runtime that makes it easy to run open-source models on your machine. OpenClaw integrates with Ollama's native API (`/api/chat`), supporting streaming and tool calling, and can **auto-discover tool-capable models** when you opt in with `OLLAMA_API_KEY` (or an auth profile) and do not define an explicit `models.providers.ollama` entry.

<Warning>
**Do not use `/v1` URLs or `api: "openai-responses"` / `api: "openai-completions"` with Ollama.** These OpenAI-compatible endpoints silently break tool calling -- the model outputs raw JSON instead of structured tool calls, which leaks into chat as plain text. Always use `api: "ollama"` (the default) and omit `/v1` from `baseUrl`. See [Legacy OpenAI-Compatible Mode](#legacy-openai-compatible-mode) if you have a specific reason to use the OpenAI-compatible endpoint.
</Warning>

## Quick start

1. Install Ollama: [https://ollama.ai](https://ollama.ai)

2. Pull a model:

```bash
ollama pull gpt-oss:20b
# or
ollama pull llama3.3
# or
ollama pull qwen2.5-coder:32b
# or
ollama pull deepseek-r1:32b
```

3. Enable Ollama for OpenClaw (any value works; Ollama doesn't require a real key):

```bash
# Set environment variable
export OLLAMA_API_KEY="ollama-local"

# Or configure in your config file
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

4. Use Ollama models:

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/gpt-oss:20b" },
    },
  },
}
```

## Model discovery (implicit provider)

When you set `OLLAMA_API_KEY` (or an auth profile) and **do not** define `models.providers.ollama`, OpenClaw discovers models from the local Ollama instance at `http://127.0.0.1:11434`:

- Queries `/api/tags` and `/api/show`
- Keeps only models that report `tools` capability
- Marks `reasoning` when the model reports `thinking`
- Reads `contextWindow` from `model_info["<arch>.context_length"]` when available
- Sets `maxTokens` to 10× the context window
- Sets all costs to `0`

This avoids manual model entries while keeping the catalog aligned with Ollama's capabilities.

To see what models are available:

```bash
ollama list
openclaw models list
```

To add a new model, simply pull it with Ollama:

```bash
ollama pull mistral
```

The new model will be automatically discovered and available to use.

If you set `models.providers.ollama` explicitly, auto-discovery is skipped and you must define models manually (see below).

## Configuration

### Basic setup (implicit discovery)

The simplest way to enable Ollama is via environment variable:

```bash
export OLLAMA_API_KEY="ollama-local"
```

### Explicit setup (manual models)

Use explicit config when:

- Ollama runs on another host/port.
- You want to force specific context windows or model lists.
- You want to include models that do not report tool support.

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434",
        apiKey: "ollama-local",
        api: "ollama",
        models: [
          {
            id: "gpt-oss:20b",
            name: "GPT-OSS 20B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 8192 * 10
          }
        ]
      }
    }
  }
}
```

If `OLLAMA_API_KEY` is set, you can omit `apiKey` in the provider entry and OpenClaw will fill it for availability checks.

### Custom base URL (explicit config)

If Ollama is running on a different host or port (explicit config disables auto-discovery, so define models manually):

```json5
{
  models: {
    providers: {
      ollama: {
        apiKey: "ollama-local",
        baseUrl: "http://ollama-host:11434", // No /v1 - use native Ollama API URL
        api: "ollama", // Set explicitly to guarantee native tool-calling behavior
      },
    },
  },
}
```

<Warning>
<<<<<<< HEAD
Do not add `/v1` to the URL. The `/v1` path uses OpenAI-compatible mode, where tool calling is not reliable. Use the base Ollama URL without a path suffix.
=======
Do not append `/v1` to the `baseUrl`. The native Ollama API uses `/api/chat` (handled automatically by OpenClaw). Adding `/v1` forces the OpenAI-compatible endpoint, which breaks tool calling.
>>>>>>> 6e47600c1 (docs(ollama): warn that /v1 and openai-responses/openai-completions break tool calling)
</Warning>

### Model selection

Once configured, all your Ollama models are available:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "ollama/gpt-oss:20b",
        fallbacks: ["ollama/llama3.3", "ollama/qwen2.5-coder:32b"],
      },
    },
  },
}
```

## Advanced

### Reasoning models

OpenClaw marks models as reasoning-capable when Ollama reports `thinking` in `/api/show`:

```bash
ollama pull deepseek-r1:32b
```

### Model Costs

Ollama is free and runs locally, so all model costs are set to $0.

### Streaming Configuration

OpenClaw's Ollama integration uses the **native Ollama API** (`/api/chat`) by default, which fully supports streaming and tool calling simultaneously. No special configuration is needed.

#### Legacy OpenAI-Compatible Mode

<Warning>
<<<<<<< HEAD
**Tool calling is not reliable in OpenAI-compatible mode.** Use this mode only if you need OpenAI format for a proxy and do not depend on native tool calling behavior.
=======
**This mode breaks tool calling.** Ollama's `/v1` OpenAI-compatible endpoint does not return structured `tool_calls`. Instead, models output tool call JSON as plain text, which OpenClaw passes through as a chat message. Only use this mode if you are behind a proxy that exclusively supports the OpenAI format **and** you do not need tool calling.
>>>>>>> 6e47600c1 (docs(ollama): warn that /v1 and openai-responses/openai-completions break tool calling)
</Warning>

If you need to use the OpenAI-compatible endpoint instead (e.g., behind a proxy that only supports OpenAI format), set `api: "openai-completions"` explicitly:

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434/v1",
        api: "openai-completions",
        injectNumCtxForOpenAICompat: true, // default: true
        apiKey: "ollama-local",
        models: [...]
      }
    }
  }
}
```

<<<<<<< HEAD
This mode may not support streaming + tool calling simultaneously. You may need to disable streaming with `params: { streaming: false }` in model config.

When `api: "openai-completions"` is used with Ollama, OpenClaw injects `options.num_ctx` by default so Ollama does not silently fall back to a 4096 context window. If your proxy/upstream rejects unknown `options` fields, disable this behavior:

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434/v1",
        api: "openai-completions",
        injectNumCtxForOpenAICompat: false,
        apiKey: "ollama-local",
        models: [...]
      }
    }
  }
}
```
=======
Note: The OpenAI-compatible endpoint does not support tool calling via structured `tool_calls` responses. You may also need to disable streaming with `params: { streaming: false }` in model config.
>>>>>>> 6e47600c1 (docs(ollama): warn that /v1 and openai-responses/openai-completions break tool calling)

### Context windows

For auto-discovered models, OpenClaw uses the context window reported by Ollama when available, otherwise it defaults to `8192`. You can override `contextWindow` and `maxTokens` in explicit provider config.

## Troubleshooting

### Ollama not detected

Make sure Ollama is running and that you set `OLLAMA_API_KEY` (or an auth profile), and that you did **not** define an explicit `models.providers.ollama` entry:

```bash
ollama serve
```

And that the API is accessible:

```bash
curl http://localhost:11434/api/tags
```

### No models available

OpenClaw only auto-discovers models that report tool support. If your model isn't listed, either:

- Pull a tool-capable model, or
- Define the model explicitly in `models.providers.ollama`.

To add models:

```bash
ollama list  # See what's installed
ollama pull gpt-oss:20b  # Pull a tool-capable model
ollama pull llama3.3     # Or another model
```

### Tool calls appear as raw JSON in chat

If the model outputs tool call JSON as plain text instead of actually calling tools, your provider is likely configured with `api: "openai-responses"`, `api: "openai-completions"`, or a `baseUrl` ending in `/v1`. These settings route requests through Ollama's OpenAI-compatible endpoint, which does not return structured tool calls.

**Fix:** Switch to the native Ollama API by removing `/v1` from `baseUrl` and setting `api: "ollama"` (or omitting `api` entirely, since `"ollama"` is the default):

```json5
{
  models: {
    providers: {
      ollama: {
        // Use the base Ollama URL without /v1
        baseUrl: "http://ollama-host:11434",
        // api: "ollama" is the default -- no need to set it
        apiKey: "ollama-local",
      },
    },
  },
}
```

### Connection refused

Check that Ollama is running on the correct port:

```bash
# Check if Ollama is running
ps aux | grep ollama

# Or restart Ollama
ollama serve
```

## See Also

- [Model Providers](/concepts/model-providers) - Overview of all providers
- [Model Selection](/concepts/models) - How to choose models
- [Configuration](/gateway/configuration) - Full config reference
