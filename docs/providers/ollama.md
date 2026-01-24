---
summary: "Run Clawdbot with Ollama (local LLM runtime)"
read_when:
  - You want to run Clawdbot with local models via Ollama
  - You need Ollama setup and configuration guidance
---
# Ollama

Ollama is a local LLM runtime that makes it easy to run open-source models on your machine. Clawdbot integrates with Ollama's OpenAI-compatible API and **automatically discovers models** installed on your machine.

## Quick start

1) Install Ollama: https://ollama.ai

2) Pull a model:

```bash
ollama pull llama3.3
# or
ollama pull qwen2.5-coder:32b
# or
ollama pull deepseek-r1:32b
```

3) Configure Clawdbot with Ollama API key:

```bash
# Set environment variable
export OLLAMA_API_KEY="ollama-local"

# Or configure in your config file
clawdbot config set models.providers.ollama.apiKey "ollama-local"
```

4) Use Ollama models:

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/llama3.3" }
    }
  }
}
```

## Model Discovery

When the Ollama provider is configured, Clawdbot automatically detects all models installed on your Ollama instance by querying the `/api/tags` endpoint at `http://localhost:11434`. You don't need to manually configure individual models in your config file.

To see what models are available:

```bash
ollama list
clawdbot models list
```

To add a new model, simply pull it with Ollama:

```bash
ollama pull mistral
```

The new model will be automatically discovered and available to use.

## Configuration

### Basic Setup

The simplest way to enable Ollama is via environment variable:

```bash
export OLLAMA_API_KEY="ollama-local"
```

### Custom Base URL

If Ollama is running on a different host or port:

```json5
{
  models: {
    providers: {
      ollama: {
        apiKey: "ollama-local",
        baseUrl: "http://192.168.1.100:11434/v1"
      }
    }
  }
}
```

### Model Selection

Once configured, all your Ollama models are available:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "ollama/llama3.3",
        fallback: ["ollama/qwen2.5-coder:32b"]
      }
    }
  }
}
```

## Advanced

### Reasoning Models

Models with "r1" or "reasoning" in their name are automatically detected as reasoning models and will use extended thinking features:

```bash
ollama pull deepseek-r1:32b
```

### Model Costs

Ollama is free and runs locally, so all model costs are set to $0.

### Context Windows

Ollama models use default context windows. You can customize these in your provider configuration if needed.

## Troubleshooting

### Ollama not detected

Make sure Ollama is running:

```bash
ollama serve
```

And that the API is accessible:

```bash
curl http://localhost:11434/api/tags
```

### No models available

Pull at least one model:

```bash
ollama list  # See what's installed
ollama pull llama3.3  # Pull a model
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
- [Model Selection](/agents/model-selection) - How to choose models
- [Configuration](/configuration) - Full config reference
