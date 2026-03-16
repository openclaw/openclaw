---
summary: "Run OpenClaw with Ollama (cloud and local models)"
read_when:
  - You want to run OpenClaw with cloud or local models via Ollama
  - You need Ollama setup and configuration guidance
title: "Ollama"
---

# Ollama

Ollama is a local LLM runtime that makes it easy to run open-source models on your machine. OpenClaw integrates with Ollama's native API (`/api/chat`), supports streaming and tool calling, and can auto-discover local Ollama models when you opt in with `OLLAMA_API_KEY` (or an auth profile) and do not define an explicit `models.providers.ollama` entry.

<Warning>
**Remote Ollama users**: Do not use the `/v1` OpenAI-compatible URL (`http://host:11434/v1`) with OpenClaw. This breaks tool calling and models may output raw tool JSON as plain text. Use the native Ollama API URL instead: `baseUrl: "http://host:11434"` (no `/v1`).
</Warning>

## Quick start

### Onboarding wizard (recommended)

The fastest way to set up Ollama is through the setup wizard:

```bash
openclaw onboard
```

Select **Ollama** from the provider list. The wizard will:

1. Ask for the Ollama base URL where your instance can be reached (default `http://127.0.0.1:11434`).
2. Let you choose **Cloud + Local** (cloud models and local models) or **Local** (local models only).
3. Open a browser sign-in flow if you choose **Cloud + Local** and are not signed in to ollama.com.
4. Discover available models and suggest defaults.
5. Auto-pull the selected model if it is not available locally.

Non-interactive mode is also supported:

```bash
openclaw onboard --non-interactive \
  --auth-choice ollama \
  --accept-risk
```

Optionally specify a custom base URL or model:

```bash
openclaw onboard --non-interactive \
  --auth-choice ollama \
  --custom-base-url "http://ollama-host:11434" \
  --custom-model-id "qwen3.5:27b" \
  --accept-risk
```

### Manual setup

1. Install Ollama: [https://ollama.com/download](https://ollama.com/download)

2. Pull a local model if you want local inference:

```bash
ollama pull glm-4.7-flash
# or
ollama pull gpt-oss:20b
# or
ollama pull llama3.3
```

3. If you want cloud models too, sign in:

```bash
ollama signin
```

4. Run onboarding and choose `Ollama`:

```bash
openclaw onboard
```

- `Local`: local models only
- `Cloud + Local`: local models plus cloud models
- Cloud models such as `kimi-k2.5:cloud`, `minimax-m2.5:cloud`, and `glm-5:cloud` do **not** require a local `ollama pull`

OpenClaw currently suggests:

- local default: `glm-4.7-flash`
- cloud defaults: `kimi-k2.5:cloud`, `minimax-m2.5:cloud`, `glm-5:cloud`

5. If you prefer manual setup, enable Ollama for OpenClaw directly (any value works; Ollama doesn't require a real key):

```bash
# Set environment variable
export OLLAMA_API_KEY="ollama-local"

# Or configure in your config file
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

6. Inspect or switch models:

```bash
openclaw models list
openclaw models set ollama/glm-4.7-flash
```

7. Or set the default in config:

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/glm-4.7-flash" },
    },
  },
}
```

## Model discovery (implicit provider)

When you set `OLLAMA_API_KEY` (or an auth profile) and **do not** define `models.providers.ollama`, OpenClaw discovers models from the local Ollama instance at `http://127.0.0.1:11434`:

- Queries `/api/tags`
- Uses best-effort `/api/show` lookups to read `contextWindow` when available
- Marks `reasoning` with a model-name heuristic (`r1`, `reasoning`, `think`)
- Sets `maxTokens` to the default Ollama max-token cap used by OpenClaw
- Sets all costs to `0`

This avoids manual model entries while keeping the catalog aligned with the local Ollama instance.

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
- You want fully manual model definitions.

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
Do not add `/v1` to the URL. The `/v1` path uses OpenAI-compatible mode, where tool calling is not reliable. Use the base Ollama URL without a path suffix.
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

## Cloud models

Cloud models let you run cloud-hosted models (for example `kimi-k2.5:cloud`, `minimax-m2.5:cloud`, `glm-5:cloud`) alongside your local models.

To use cloud models, select **Cloud + Local** mode during setup. The wizard checks whether you are signed in and opens a browser sign-in flow when needed. If authentication cannot be verified, the wizard falls back to local model defaults.

You can also sign in directly at [ollama.com/signin](https://ollama.com/signin).

## Advanced

### Reasoning models

OpenClaw treats models with names such as `deepseek-r1`, `reasoning`, or `think` as reasoning-capable by default:

```bash
ollama pull deepseek-r1:32b
```

### Model Costs

Ollama is free and runs locally, so all model costs are set to $0.

### Streaming Configuration

OpenClaw's Ollama integration uses the **native Ollama API** (`/api/chat`) by default, which fully supports streaming and tool calling simultaneously. No special configuration is needed.

#### Legacy OpenAI-Compatible Mode

<Warning>
**Tool calling is not reliable in OpenAI-compatible mode.** Use this mode only if you need OpenAI format for a proxy and do not depend on native tool calling behavior.
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

### Context windows

For auto-discovered models, OpenClaw uses the context window reported by Ollama when available, otherwise it falls back to the default Ollama context window used by OpenClaw. You can override `contextWindow` and `maxTokens` in explicit provider config.

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

If your model is not listed, either:

- Pull the model locally, or
- Define the model explicitly in `models.providers.ollama`.

To add models:

```bash
ollama list  # See what's installed
ollama pull glm-4.7-flash
ollama pull gpt-oss:20b
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

## See Also

- [Model Providers](/concepts/model-providers) - Overview of all providers
- [Model Selection](/concepts/models) - How to choose models
- [Configuration](/gateway/configuration) - Full config reference
