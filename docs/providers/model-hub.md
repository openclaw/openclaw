---
summary: "How to use Model Hub as an LLM provider in OpenClaw"
read_when:
  - You want to configure Model Hub as a provider
  - You need to set up api.model-hub.cn
title: "Model Hub"
---

# Model Hub

[Model Hub](https://api.model-hub.cn) is an aggregated model provider that offers
access to multiple LLM models through a single OpenAI-compatible API endpoint.

## Setup

### 1. Get an API key

Obtain your API key from the Model Hub platform.

### 2. Authenticate

```bash
openclaw onboard --model-hub-api-key <your-key>
```

Or set the environment variable:

```bash
export MODEL_HUB_API_KEY=your-api-key
```

### 3. Set the default model

```json5
{
  agents: { defaults: { model: { primary: "model-hub/gemini-3-flash-preview" } } },
}
```

## Configuration

Model Hub uses the OpenAI-compatible chat completions API. Models are
discovered dynamically from the `/v1/models` endpoint.

### Custom configuration

```json5
{
  models: {
    providers: {
      "model-hub": {
        baseUrl: "https://api.model-hub.cn/v1",
        apiKey: "${MODEL_HUB_API_KEY}",
        api: "openai-completions",
      },
    },
  },
}
```

## Available models

Models are fetched dynamically at runtime. Use `openclaw models` to see the
current list of available models after authenticating.
