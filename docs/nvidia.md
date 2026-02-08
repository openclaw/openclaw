---
summary: "NVIDIA API setup for AI model access"
read_when:
  - You want to use NVIDIA's AI models
  - You need NVIDIA_API_KEY setup
title: "NVIDIA API"
---

# NVIDIA API

OpenClaw can use NVIDIA's API (https://integrate.api.nvidia.com/v1) for accessing various AI models. NVIDIA provides access to state-of-the-art language models through their integration endpoint.

## API Setup

### NVIDIA (direct)

- Base URL: [https://integrate.api.nvidia.com/v1](https://integrate.api.nvidia.com/v1)
- Environment variable: `NVIDIA_API_KEY`
- Get your API key from: [NVIDIA NGC](https://catalog.ngc.nvidia.com/)

## Config example

```json5
{
  models: {
    providers: {
      nvidia: {
        apiKey: "nvapi-...",
        baseUrl: "https://integrate.api.nvidia.com/v1",
      },
    },
  },
  agents: {
    default: {
      provider: "nvidia",
      model: "nvidia/llama-3.1-nemotron-70b-instruct",
    },
  },
}
```

## Available Models

OpenClaw includes support for several NVIDIA models:

- `nvidia/llama-3.1-nemotron-70b-instruct` (default) — High-performance instruction-following model
- `nvidia/llama-3.3-70b-instruct` — Latest Llama 3.3 variant
- `nvidia/mistral-nemo-minitron-8b-8k-instruct` — Smaller, efficient model

## Environment Variable Setup

Set your NVIDIA API key as an environment variable:

```bash
export NVIDIA_API_KEY="nvapi-your-key-here"
```

Or add it to your `.env` file:

```bash
NVIDIA_API_KEY=nvapi-your-key-here
```

## Usage in Config

Minimal configuration (uses environment variable):

```json5
{
  agents: {
    default: {
      provider: "nvidia",
      model: "nvidia/llama-3.1-nemotron-70b-instruct",
    },
  },
}
```

Explicit API key configuration:

```json5
{
  models: {
    providers: {
      nvidia: {
        apiKey: "NVIDIA_API_KEY",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        api: "openai-completions",
      },
    },
  },
}
```

## Professional and Personal Use

NVIDIA's API is suitable for both professional and personal applications:

- **Professional**: Enterprise-grade models for business applications, research, and development
- **Personal**: Access to powerful AI models for learning, experimentation, and personal projects

## Notes

- NVIDIA API uses OpenAI-compatible endpoints
- Models are automatically discovered if `NVIDIA_API_KEY` is set
- Default context window: 131,072 tokens
- Default max tokens: 4,096 tokens
