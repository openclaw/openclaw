# Azure OpenAI Provider

Azure OpenAI Service provides access to OpenAI models (GPT-4o, o1, o3-mini, etc.) with enterprise-grade security and compliance via your Azure subscription.

## Setup

1. Create an Azure OpenAI resource in the [Azure Portal](https://portal.azure.com)
2. Deploy a model (e.g., `gpt-4o`) in Azure AI Studio
3. Copy your API key and endpoint

```bash
export AZURE_OPENAI_API_KEY=your-key-here
export AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
```

Or add to `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "providers": {
      "azure-openai": {
        "apiKey": "your-key-here",
        "baseUrl": "https://your-resource.openai.azure.com/openai/deployments/your-deployment"
      }
    }
  }
}
```

## Models

| Model ID | Description | Context |
|----------|-------------|---------|
| `azure-openai/gpt-4o` | GPT-4o (latest) | 128k |
| `azure-openai/gpt-4o-mini` | GPT-4o Mini | 128k |
| `azure-openai/gpt-4-turbo` | GPT-4 Turbo | 128k |
| `azure-openai/o1` | o1 reasoning model | 200k |
| `azure-openai/o3-mini` | o3-mini reasoning | 200k |

> **Note:** Model availability depends on your Azure region and deployment configuration.
> The model ID in OpenClaw should match your **deployment name** in Azure.

## Pricing

See [Azure OpenAI pricing](https://azure.microsoft.com/pricing/details/cognitive-services/openai-service/).

## Notes

- Azure OpenAI uses the OpenAI-compatible API (`openai-completions`)
- Requires both `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_ENDPOINT`
- Each deployed model has its own endpoint: `{endpoint}/openai/deployments/{deployment-name}`
