---
summary: "Use ShengSuanYun (胜算云) models in Moltbot"
read_when:
  - You want to use ShengSuanYun model router
  - You need ShengSuanYun setup guidance
---

# ShengSuanYun (胜算云)

ShengSuanYun provides a unified router for accessing multiple AI model providers through a single API endpoint, supporting both LLM models and multimodal generative models (text-to-image, image-to-video, etc.).

## Why ShengSuanYun in Moltbot

- **Unified API** for multiple model providers
- **LLM Support**: OpenAI, Anthropic, Google, DeepSeek, and many others
- **Multimodal Support**: Text-to-image, image-to-video, and other generative models
- **OpenAI-compatible** `/v1` endpoints for LLMs
- **Anthropic-compatible** `/v1/messages` endpoint
- **Wide model selection** from different providers
- **Automatic model discovery** from the provider's API

## Features

### LLM Models

- **Multi-provider access**: Access models from OpenAI, Anthropic, Google, Ali, ByteDance, DeepSeek, Meta, and more
- **Multiple API formats**: Supports `/v1/chat/completions`, `/v1/messages`, and `/v1/responses`
- **Streaming**: ✅ Supported on all compatible models
- **Function calling**: ✅ Supported on compatible models
- **Vision**: ✅ Supported on models with vision capability
- **Dynamic model discovery**: Models are automatically discovered from the API

### Multimodal Models

- **Text-to-Image**: GPT-Image, Doubao-Seedream, Qwen-Image-Plus, Flux models
- **Text-to-Video**: Veo3.1, Sora2, 通义万相 (Wanxiang) models
- **Image-to-Video**: Doubao-Seedance, Wanxiang image-to-video models
- **Image-to-Image**: Flux-kontext-pro, Wanxiang image editing models
- **Automatic discovery**: Over 200+ multimodal models available

## Setup

### 1. Get API Key

1. Sign up at [ShengSuanYun](https://shengsuanyun.com)
2. Navigate to [API settings](https://console.shengsuanyun.com/user/keys)
3. Generate an API key

### 2. Configure Moltbot

**Option A: Environment Variable**

```bash
export SHENGSUANYUN_API_KEY="your-api-key"
```

**Option B: Config File**

Add to your `moltbot.json`:

```json5
{
  env: { SHENGSUANYUN_API_KEY: "your-api-key" },
  agents: {
    defaults: {
      model: { primary: "shengsuanyun/anthropic/claude-opus-4.5" },
    },
  },
}
```

### 3. Verify Setup

```bash
moltbot models list | grep shengsuanyun
moltbot chat --model shengsuanyun/anthropic/claude-opus-4.5 "Hello, are you working?"
```

## Model Selection

ShengSuanYun provides access to hundreds of models from various providers. Models are identified by their provider prefix:

### LLM Providers

- **OpenAI**: `openai/gpt-5.1`, `openai/gpt-5.2`, `openai/o3`
- **Anthropic**: `anthropic/claude-opus-4.5`, `anthropic/claude-sonnet-4.5`, `anthropic/claude-haiku-4.5`
- **Google**: `google/gemini-3-pro-preview`, `google/gemini-3-flash`
- **DeepSeek**: `deepseek/deepseek-chat`, `deepseek/deepseek-reasoner`
- **Ali**: Various Qwen models
- **ByteDance**: Various Doubao models
- **Meta**: Llama models
- And many more...

### Multimodal Models

Multimodal models use the prefix `modality/{id}` format:

#### Text-to-Image Models

- **GPT-Image**: OpenAI's image generation models
- **Doubao-Seedream**: ByteDance's text-to-image models (4.5 series)
- **Qwen-Image-Plus**: Ali's advanced image generation
- **Flux**: BlackForestLabs' high-quality image models

#### Text-to-Video Models

- **Veo3.1**: Google's video generation model
- **Sora2**: OpenAI's video generation model
- **通义万相 (Wanxiang)**: Ali's text-to-video models (2.2-Plus)

#### Image-to-Video Models

- **Doubao-Seedance**: ByteDance's image-to-video conversion
- **通义万相 (Wanxiang)**: Ali's image-to-video models (2.5, 2.6)

#### Image-to-Image Models

- **Flux-kontext-pro**: Advanced image editing
- **通义万相 (Wanxiang)**: Ali's image editing models (2.5)

List all available models:

```bash
# List all models
moltbot models list | grep shengsuanyun

# List only LLM models
moltbot models list | grep "shengsuanyun" | grep -v "modality"

# List only multimodal models
moltbot models list | grep "shengsuanyun/modality"
```

Change your default model:

```bash
# Set LLM model
moltbot models set shengsuanyun/anthropic/claude-opus-4.5

# Set multimodal model (if supported by your workflow)
moltbot models set shengsuanyun/modality/256
```

## Model Discovery

Moltbot automatically discovers models from two ShengSuanYun APIs when `SHENGSUANYUN_API_KEY` is configured:

1. **LLM Models API**: `https://router.shengsuanyun.com/api/v1/models`
   - Returns all text-based chat and completion models
   - Includes models from major AI providers
   - Supports filtering by API compatibility

2. **Multimodal Models API**: `https://api.shengsuanyun.com/modelrouter/modalities/list`
   - Returns generative models for images and videos
   - Includes text-to-image, image-to-video, and image-to-image models
   - Over 200+ models available

Each model includes:

- Model ID and name
- Company/provider information
- Context window size and max tokens (for LLMs)
- Maximum output tokens
- Supported APIs
- Pricing information
- Input modality support (text, image, etc.)
- Model capabilities and classifications

## API Compatibility

ShengSuanYun supports multiple API formats:

| API Format         | Endpoint               | Compatible With |
| ------------------ | ---------------------- | --------------- |
| OpenAI Completions | `/v1/chat/completions` | OpenAI SDK      |
| Anthropic Messages | `/v1/messages`         | Claude SDK      |
| OpenAI Responses   | `/v1/responses`        | OpenAI SDK      |

Moltbot automatically uses the appropriate API format based on the model's capabilities, preferring the OpenAI completions format when available.

## Usage Examples

### LLM Models

```bash
# Use Claude via ShengSuanYun
moltbot chat --model shengsuanyun/anthropic/claude-opus-4.5

# Use GPT-5.2
moltbot chat --model shengsuanyun/openai/gpt-5.2

# Use Gemini
moltbot chat --model shengsuanyun/google/gemini-3-pro-preview

# Use DeepSeek
moltbot chat --model shengsuanyun/deepseek/deepseek-chat
```

### Multimodal Models

Note: Multimodal model integration depends on your specific workflow and use case. The models are discovered and listed but may require additional configuration or API integration for image/video generation tasks.

```bash
# List available multimodal models
moltbot models list | grep "modality"

# Example multimodal model IDs (text-to-image, image-to-video, etc.)
# - shengsuanyun/modality/256  (Ali Wanxiang 2.6 I2V)
# - shengsuanyun/modality/XXX  (Other generative models)
```

## Configuration Example

Full configuration in `moltbot.json`:

```json5
{
  env: { SHENGSUANYUN_API_KEY: "your-api-key" },
  agents: {
    defaults: {
      model: { primary: "shengsuanyun/anthropic/claude-opus-4.5" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      shengsuanyun: {
        baseUrl: "https://router.shengsuanyun.com/api/v1",
        apiKey: "${SHENGSUANYUN_API_KEY}",
        api: "openai-completions",
        models: [], // Models are auto-discovered
      },
    },
  },
}
```

## Pricing

ShengSuanYun uses its own pricing model. Check the ShengSuanYun dashboard for current rates per model. Pricing varies by:

- Model provider
- Model size and capability
- Input/output tokens
- Additional features (vision, etc.)

## Troubleshooting

### API key not recognized

```bash
echo $SHENGSUANYUN_API_KEY
moltbot models list | grep shengsuanyun
```

Verify your API key is valid and has the correct permissions.

### Model not available

The ShengSuanYun model catalog updates dynamically. Run `moltbot models list` to see currently available models. Some models may be temporarily unavailable.

### Connection issues

ShengSuanYun API is at `https://router.shengsuanyun.com/api/v1`. Ensure your network allows HTTPS connections.

## Links

- [ShengSuanYun Website](https://router.shengsuanyun.com)
- [Model List API](https://router.shengsuanyun.com/api/v1/models)
