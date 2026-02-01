---
summary: "Use Azure OpenAI models (GPT-4o, GPT-5, etc.) natively in OpenClaw"
read_when:
  - You want to use Azure OpenAI models
  - You have Azure credits or an Azure OpenAI deployment
  - You need enterprise-grade Azure compliance
title: "Azure OpenAI"
---

# Azure OpenAI

Azure OpenAI Service provides enterprise-grade access to OpenAI models (GPT-4o, GPT-5, etc.) with Azure security and compliance features.

## Why Azure OpenAI

- **Enterprise compliance**: SOC 2, HIPAA, and other certifications
- **Azure credits**: Use existing Azure Sponsorship, Enterprise Agreements, or MSDN subscriptions
- **Regional deployment**: Deploy models in specific Azure regions
- **Private networking**: VNet integration and private endpoints

## Setup

OpenClaw supports Azure OpenAI natively using the `azure-openai-responses` API.

### Step 1: Set Environment Variables

```bash
export AZURE_OPENAI_API_KEY="your-azure-api-key"
```

### Step 2: Configure OpenClaw

Add to `~/.openclaw/openclaw.json`:

```json5
{
  models: {
    mode: "merge",
    providers: {
      "azure-openai": {
        baseUrl: "https://your-resource.openai.azure.com/openai/v1",
        apiKey: "${AZURE_OPENAI_API_KEY}",
        api: "azure-openai-responses",
        models: [
          {
            id: "your-deployment-name",
            name: "GPT-5.2 Codex (Azure)",
            reasoning: false,
            input: ["text", "image"],
            contextWindow: 200000,
            maxTokens: 16384,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "azure-openai/your-deployment-name" },
    },
  },
}
```

### Key Configuration

| Field     | Description                                     |
| --------- | ----------------------------------------------- |
| `baseUrl` | Your Azure endpoint + `/openai/v1`              |
| `api`     | Must be `"azure-openai-responses"`              |
| `id`      | Your Azure deployment name (not the model name) |

## Environment Variables

The pi-ai library also supports these environment variables:

| Variable                           | Description                                                            |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `AZURE_OPENAI_API_KEY`             | Your Azure API key                                                     |
| `AZURE_OPENAI_BASE_URL`            | Full base URL (alternative to config)                                  |
| `AZURE_OPENAI_RESOURCE_NAME`       | Resource name (builds URL automatically)                               |
| `AZURE_OPENAI_API_VERSION`         | API version (default: v1)                                              |
| `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` | Map model IDs to deployments (format: `model1=deploy1,model2=deploy2`) |

## Finding Your Azure Configuration

1. **Resource Endpoint**: Azure Portal > Your OpenAI Resource > Overview > Endpoint
2. **Deployment Name**: Azure Portal > Your OpenAI Resource > Model Deployments
3. **API Key**: Azure Portal > Your OpenAI Resource > Keys and Endpoint

## Troubleshooting

### "Azure OpenAI base URL is required" error

Ensure your config includes the full base URL:

```json5
{
  baseUrl: "https://your-resource.openai.azure.com/openai/v1",
}
```

### "No API key" error

Set the `AZURE_OPENAI_API_KEY` environment variable or include `apiKey` in config.

### Model not found

The model `id` in config must match your **Azure deployment name**, not the OpenAI model name.

## See Also

- [Model Providers](/concepts/model-providers) - Overview of all providers
- [Model Failover](/concepts/model-failover) - Configure fallback models
