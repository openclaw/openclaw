---
summary: "Use Mistral AI models in OpenClaw"
read_when:
  - You want to use Mistral models in OpenClaw
  - You need to set up Mistral API authentication
title: "Mistral AI"
---

# Mistral AI

Mistral AI provides access to a range of models including Mistral 7B, Mistral Medium, and Mistral Large. OpenClaw supports Mistral API authentication and model selection.

## Setup

### 1. Get API Key

1. Visit [Mistral AI Console](https://console.mistral.ai)
2. Create an account or log in
3. Navigate to **API Keys** section
4. Create a new API key
5. Copy your API key (starts with `sk-`)

### 2. Configure OpenClaw

**Interactive setup:**
```bash
openclaw onboard
# Choose: Mistral AI
# Paste your API key when prompted
```

**Non-interactive setup:**
```bash
openclaw onboard --mistral-api-key "sk-..."
```

### 3. Set Default Model

Add to your configuration:

```json5
{
  agents: {
    defaults: {
      model: { primary: "mistral/mistral-large-2407" }
    }
  }
}
```

## Available Models

| Model | Description | Use Case |
|-------|-------------|----------|
| `mistral-7b-instruct-v0.3` | Small, fast model | Quick responses, limited context |
| `mistral-8x7b-instruct-v0.1` | MoE model | Balanced cost/performance |
| `mistral-large-2407` | Large, capable model | Complex tasks, reasoning |
| `mistral-nemo-2407` | Latest model | Best performance/cost ratio |

## Configuration Example

```json5
{
  env: {
    MISTRAL_API_KEY: "sk-..."
  },
  agents: {
    defaults: {
      models: {
        "mistral/mistral-large-2407": {}
      }
    }
  }
}
```

## Authentication

OpenClaw uses the `MISTRAL_API_KEY` environment variable or configuration:

```bash
export MISTRAL_API_KEY="sk-..."
openclaw start
```

## Pricing

Mistral models are billed on a per-token basis. Check [Mistral Pricing](https://mistral.ai/pricing/) for current rates.

## Troubleshooting

### Authentication Error
- Verify API key is correct
- Check key hasn't expired
- Ensure key is valid in Mistral console

### Model Not Found
- Verify model name is exact match
- Check model is available in your region
- Confirm account has access to model

### Rate Limiting
- Reduce request frequency
- Add delays between requests
- Contact Mistral for higher limits

## See Also

- [Model Providers](/providers) - Other provider options
- [Configuration](/gateway/configuration) - Advanced settings
