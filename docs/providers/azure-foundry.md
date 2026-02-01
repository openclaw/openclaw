---
summary: "Run OpenClaw with Azure AI Foundry (Azure OpenAI and other Azure-hosted models)"
read_when:
  - You want to run OpenClaw with Azure AI Foundry
  - You need Azure OpenAI or Azure-hosted model setup guidance
  - You want to use custom Azure model deployments
---

# Azure AI Foundry

Azure AI Foundry is Microsoft's unified AI platform that provides access to OpenAI models (GPT-4, GPT-4.1, etc.) and other models through Azure. OpenClaw integrates with Azure AI Foundry using the OpenAI-compatible API.

## Quick start

1. Create an Azure AI Foundry resource and deploy a model (e.g., `gpt-4.1`)

2. Get your API key and endpoint from the Azure Portal

3. Configure OpenClaw:

```bash
# Set environment variables
export AZURE_FOUNDRY_API_KEY="your-azure-api-key"
export AZURE_FOUNDRY_BASE_URL="https://your-resource.openai.azure.com"

# Or configure the provider in your config file
openclaw config set models.providers.azure-foundry.baseUrl "https://your-resource.openai.azure.com"
```

4. Add your model deployment:

```json5
{
  models: {
    providers: {
      "azure-foundry": {
        baseUrl: "https://your-resource.openai.azure.com",
        apiKey: "AZURE_FOUNDRY_API_KEY",
        api: "openai-completions",
        models: [
          {
            id: "your-deployment-name", // e.g., "my-gpt-4"
            name: "GPT-4.1 on Azure",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 16384,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "azure-foundry/your-deployment-name" },
    },
  },
}
```

## Configuration

### Environment variable

Set your Azure API key:

```bash
export AZURE_FOUNDRY_API_KEY="your-azure-api-key"
```

### Provider configuration

Azure AI Foundry requires explicit model configuration because deployment names are custom:

```json5
{
  models: {
    providers: {
      "azure-foundry": {
        // Your Azure OpenAI endpoint
        baseUrl: "https://your-resource.openai.azure.com",
        // Reference the env var or set directly
        apiKey: "AZURE_FOUNDRY_API_KEY",
        // Azure uses OpenAI-compatible API
        api: "openai-completions",
        models: [
          {
            // Your deployment name (not the model name)
            id: "dbandaru-gpt-4.1",
            name: "GPT-4.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 16384,
          },
          {
            id: "my-gpt-4o",
            name: "GPT-4o",
            reasoning: false,
            input: ["text", "image"], // Vision model
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 16384,
          },
        ],
      },
    },
  },
}
```

### Model selection

Once configured, use your Azure models:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "azure-foundry/dbandaru-gpt-4.1",
        fallback: ["azure-foundry/my-gpt-4o"],
      },
    },
  },
}
```

## Key differences from OpenAI

| Aspect           | OpenAI                     | Azure AI Foundry                        |
| ---------------- | -------------------------- | --------------------------------------- |
| Model ID         | `gpt-4.1`                  | Your deployment name (e.g., `my-gpt-4`) |
| Endpoint         | `api.openai.com`           | `your-resource.openai.azure.com`        |
| API Key          | `OPENAI_API_KEY`           | `AZURE_FOUNDRY_API_KEY`                 |
| Model validation | Checked against known list | You define models in config             |

## Multiple Azure deployments

You can configure multiple Azure endpoints by using different provider names:

```json5
{
  models: {
    providers: {
      "azure-foundry": {
        baseUrl: "https://prod-resource.openai.azure.com",
        apiKey: "AZURE_FOUNDRY_API_KEY",
        api: "openai-completions",
        models: [
          { id: "prod-gpt-4", name: "Production GPT-4", ... }
        ]
      },
      "azure-foundry-dev": {
        baseUrl: "https://dev-resource.openai.azure.com",
        apiKey: "AZURE_FOUNDRY_DEV_KEY",
        api: "openai-completions",
        models: [
          { id: "dev-gpt-4", name: "Dev GPT-4", ... }
        ]
      }
    }
  }
}
```

## Reasoning models

For Azure-hosted reasoning models (e.g., o1, o1-mini):

```json5
{
  models: {
    providers: {
      "azure-foundry": {
        baseUrl: "https://your-resource.openai.azure.com",
        apiKey: "AZURE_FOUNDRY_API_KEY",
        api: "openai-completions",
        models: [
          {
            id: "my-o1",
            name: "o1 on Azure",
            reasoning: true, // Enable reasoning mode
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

## Troubleshooting

### Authentication failed

Verify your API key in the Azure Portal, or test with this command (optional, requires curl):

```bash
curl -H "api-key: $AZURE_FOUNDRY_API_KEY" \
  "https://your-resource.openai.azure.com/openai/deployments?api-version=2024-02-01"
```

Alternatively, check that:

1. Your API key is correct in the Azure Portal under "Keys and Endpoint"
2. The `AZURE_FOUNDRY_API_KEY` environment variable is set
3. Your Azure resource is in an active state

### Model not found

Azure uses deployment names, not model names. Check your deployment name in the Azure Portal:

1. Go to Azure AI Foundry
2. Navigate to Deployments
3. Copy the exact deployment name (not the model name)

### Rate limiting

Azure has separate rate limits per deployment. If you hit limits, consider:

- Creating additional deployments
- Requesting quota increases in Azure Portal

### Context window mismatch

Set the correct `contextWindow` for your model:

| Model       | Context Window |
| ----------- | -------------- |
| GPT-4       | 8,192          |
| GPT-4-32k   | 32,768         |
| GPT-4 Turbo | 128,000        |
| GPT-4.1     | 128,000        |
| GPT-4o      | 128,000        |

## See Also

- [Model Providers](/concepts/model-providers) - Overview of all providers
- [Model Selection](/concepts/models) - How to choose models
- [Configuration](/gateway/configuration) - Full config reference
- [OpenAI Provider](/providers/openai) - For direct OpenAI API usage
