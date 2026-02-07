# OpenRouter Provider Plugin

OpenClaw provider plugin for [OpenRouter](https://openrouter.ai) with free models.

## Features

- **Free tier** - Multiple high-quality models at zero cost
- **Large context** - Up to 262k tokens (Qwen3 models)
- **Auto-routing** - Use `openrouter/auto` for automatic model selection
- **OpenAI-compatible** - Standard chat completions API

## Requirements

- OpenRouter API key (free at https://openrouter.ai/keys)

## Free Models

> Note: Free model availability changes frequently. Check https://openrouter.ai/models for current list.

| Model                                    | Context | Notes                       |
| ---------------------------------------- | ------- | --------------------------- |
| `openrouter/auto`                        | varies  | Auto-select best free model |
| `qwen/qwen3-next-80b-a3b-instruct:free`  | 262k    | General purpose             |
| `qwen/qwen3-coder:free`                  | 262k    | Code-focused                |
| `stepfun/step-3.5-flash:free`            | 256k    | Fast                        |
| `deepseek/deepseek-r1-0528:free`         | 164k    | Reasoning                   |
| `meta-llama/llama-3.3-70b-instruct:free` | 128k    | High quality                |
| `nvidia/nemotron-3-nano-30b-a3b:free`    | 256k    | NVIDIA                      |
| `arcee-ai/trinity-mini:free`             | 131k    | Compact                     |
| `openai/gpt-oss-120b:free`               | 131k    | GPT-style                   |

## Installation

```bash
# Via OpenClaw CLI (when merged)
openclaw models auth login --provider openrouter

# From environment variable
export OPENROUTER_API_KEY="sk-or-v1-..."
openclaw models auth login --provider openrouter --method env
```

## Usage

```bash
# Set as default (auto-select free model)
openclaw models set openrouter/auto

# Use specific model
openclaw models set openrouter/qwen/qwen3-next-80b-a3b-instruct/free

# Add to fallback chain
openclaw models fallbacks add openrouter/deepseek/deepseek-r1-0528/free
```

## Privacy Note

Free models on OpenRouter may log prompts for improvement. Do not use for sensitive data.
For private usage, consider paid models or local Ollama.

## Troubleshooting

### "Invalid API Key"

1. Check key format: should start with `sk-or-`
2. Verify at https://openrouter.ai/keys
3. Ensure key has free model access

### "Rate limited"

Free tier has lower rate limits. Options:

- Wait and retry
- Add paid credits for higher limits
- Switch to Ollama for unlimited local usage

### "Model not available"

Check model availability at https://openrouter.ai/models
Free models end with `:free` suffix.

## Development

```bash
# Test API
curl https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "openrouter/auto", "messages": [{"role": "user", "content": "Hi"}]}'
```

## License

MIT
