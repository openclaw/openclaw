# Ollama Provider Plugin

OpenClaw provider plugin for local LLM inference via [Ollama](https://ollama.com).

## Features

- **Zero cost** - Runs entirely locally
- **Full privacy** - No data leaves your machine
- **Auto-detection** - Probes Ollama for available models
- **OpenAI-compatible** - Uses Ollama's `/v1/chat/completions` endpoint

## Requirements

- Ollama installed and running (`ollama serve`)
- At least one model pulled (`ollama pull mistral`)

## Supported Models

| Model                  | Context | Notes                 |
| ---------------------- | ------- | --------------------- |
| `mistral:latest`       | 32k     | Fast, general purpose |
| `llama3.2:latest`      | 128k    | Large context         |
| `phi4-mini:latest`     | 16k     | Small, fast           |
| `deepseek-r1:7b`       | 32k     | Reasoning model       |
| `qwen2.5-coder:latest` | 32k     | Code-focused          |
| `codellama:latest`     | 16k     | Code generation       |

## Installation

```bash
# Via OpenClaw CLI (when merged)
openclaw models auth login --provider ollama

# Configure manually
openclaw models auth add --provider ollama
```

## Usage

```bash
# Set as default model
openclaw models set ollama/mistral:latest

# Add to fallback chain
openclaw models fallbacks add ollama/llama3.2:latest
```

## Troubleshooting

### "Connection refused"

Ollama isn't running:

```bash
ollama serve
```

### "Model not found"

Pull the model first:

```bash
ollama pull mistral
```

### "Context overflow"

Use a model with larger context:

```bash
openclaw models set ollama/llama3.2:latest  # 128k context
```

## Development

```bash
# Test Ollama API
curl http://localhost:11434/api/tags

# Test OpenAI-compatible endpoint
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "mistral", "messages": [{"role": "user", "content": "Hi"}]}'
```

## License

MIT
