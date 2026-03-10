---
summary: "Run OpenClaw with Ollama (local LLM runtime)"
read_when:
  - You want to run OpenClaw with local models via Ollama
  - You need Ollama setup and configuration guidance
title: "Ollama"
---

# Ollama

Ollama is a local LLM runtime that makes it easy to run open-source models on your machine. OpenClaw integrates with Ollama's OpenAI-compatible API and can **auto-discover tool-capable models** when you opt in with `OLLAMA_API_KEY` (or an auth profile) and do not define an explicit `models.providers.ollama` entry.

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
        // Use a host that includes /v1 for OpenAI-compatible APIs
        baseUrl: "http://ollama-host:11434/v1",
        apiKey: "ollama-local",
        api: "openai-completions",
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
        baseUrl: "http://ollama-host:11434/v1",
      },
    },
  },
}
```

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

Due to a [known issue](https://github.com/badlogic/pi-mono/issues/1205) in the underlying SDK with Ollama's response format, **streaming is disabled by default** for Ollama models. This prevents corrupted responses when using tool-capable models.

When streaming is disabled, responses are delivered all at once (non-streaming mode), which avoids the issue where interleaved content/reasoning deltas cause garbled output.

#### Re-enable Streaming (Advanced)

If you want to re-enable streaming for Ollama (may cause issues with tool-capable models):

```json5
{
  agents: {
    defaults: {
      models: {
        "ollama/gpt-oss:20b": {
          streaming: true,
        },
      },
    },
  },
}
```

#### Disable Streaming for Other Providers

You can also disable streaming for any provider if needed:

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-4": {
          streaming: false,
        },
      },
    },
  },
}
```

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

### Connection refused

Check that Ollama is running on the correct port:

```bash
# Check if Ollama is running
ps aux | grep ollama

# Or restart Ollama
ollama serve
```

### Corrupted responses or tool names in output

If you see garbled responses containing tool names (like `sessions_send`, `memory_get`) or fragmented text when using Ollama models, this is due to an upstream SDK issue with streaming responses. **This is fixed by default** in the latest OpenClaw version by disabling streaming for Ollama models.

If you manually enabled streaming and experience this issue:

1. Remove the `streaming: true` configuration from your Ollama model entries, or
2. Explicitly set `streaming: false` for Ollama models (see [Streaming Configuration](#streaming-configuration))

## See Also

- [Model Providers](/concepts/model-providers) - Overview of all providers
- [Model Selection](/concepts/models) - How to choose models
- [Configuration](/gateway/configuration) - Full config reference
