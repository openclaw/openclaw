---
summary: "Azure OpenAI provider with API key and keyless authentication"
read_when:
  - You want to use Azure OpenAI models with OpenClaw
  - You need keyless authentication via Azure managed identity
title: "Azure OpenAI"
---

# Azure OpenAI

Connect OpenClaw to Azure OpenAI using either API key or keyless authentication (Azure managed identity).

## Quick Start

### Method 1: API Key Authentication

```bash
openclaw models auth login --provider azure-openai --method api-key
```

You'll be prompted for:

- Azure OpenAI endpoint URL (e.g., `https://your-resource-name.openai.azure.com`)
- Deployment name (optional)
- API key

### Method 2: Keyless Authentication (DefaultAzureCredential)

```bash
openclaw models auth login --provider azure-openai --method keyless
```

This method uses Azure's `DefaultAzureCredential` which supports:

- Azure CLI (`az login`)
- Service principal (environment variables)
- Managed identity (when running on Azure)

## Prerequisites

### For API Key Authentication

1. Azure OpenAI resource created
2. API key from the Azure portal
3. Model deployed (e.g., gpt-4o, gpt-35-turbo)

### For Keyless Authentication

1. Azure OpenAI resource created
2. One of:
   - Azure CLI installed and logged in (`az login`)
   - Service principal credentials in environment
   - Managed identity on Azure resource
3. **Cognitive Services OpenAI User** role assigned to your identity

## Environment Variables

### API Key Method

```bash
export AZURE_OPENAI_API_KEY="your-api-key"
export AZURE_OPENAI_ENDPOINT="https://your-resource-name.openai.azure.com"
export AZURE_OPENAI_DEPLOYMENT_NAME="gpt-4o"  # optional
```

### Keyless Method (Service Principal)

```bash
export AZURE_CLIENT_ID="your-client-id"
export AZURE_CLIENT_SECRET="your-client-secret"
export AZURE_TENANT_ID="your-tenant-id"
```

## Configuration Example

After authentication, your config will look like:

```json5
{
  models: {
    providers: {
      "azure-openai": {
        baseUrl: "https://your-resource-name.openai.azure.com/openai/deployments/gpt-4o",
        api: "openai-completions",
        apiKey: "AZURE_OPENAI_API_KEY", // or managed via auth profiles
        models: [
          {
            id: "gpt-4o",
            name: "GPT-4o",
            reasoning: false,
            input: ["text", "image"],
            cost: {
              input: 2.5,
              output: 10,
              cacheRead: 1.25,
              cacheWrite: 2.5,
            },
            contextWindow: 128000,
            maxTokens: 16384,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: {
        primary: "azure-openai/gpt-4o",
      },
    },
  },
}
```

## Supported Models

The plugin includes pre-configured support for:

- **GPT-4o** and **GPT-4o mini** (multimodal)
- **GPT-4** and **GPT-4 Turbo** (multimodal)
- **GPT-3.5 Turbo** (text only)
- **o1-preview** and **o1-mini** (reasoning models)

## Azure RBAC Setup

For keyless authentication, assign the appropriate role:

```bash
az role assignment create \
  --role "Cognitive Services OpenAI User" \
  --assignee <your-user-or-service-principal-id> \
  --scope /subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.CognitiveServices/accounts/<openai-resource-name>
```

Alternatively, use the **Cognitive Services OpenAI Contributor** role if you need broader permissions.

## Deployments

Azure OpenAI requires deploying models before use. Each deployment has a unique name that you configure during authentication or in your config.

If you have multiple deployments, you can configure them in `models.json`:

```json5
{
  models: {
    providers: {
      "azure-openai": {
        baseUrl: "https://your-resource-name.openai.azure.com",
        api: "openai-completions",
        models: [
          {
            id: "gpt-4o-deployment-1",
            name: "GPT-4o Production",
            // ... model config
          },
          {
            id: "gpt-35-turbo-deployment-2",
            name: "GPT-3.5 Turbo Dev",
            // ... model config
          },
        ],
      },
    },
  },
}
```

## Troubleshooting

### "Authentication failed"

**For keyless auth:**

1. Verify you're logged in: `az account show`
2. Check your identity has the correct role assignment
3. Ensure environment variables are set (if using service principal)

**For API key auth:**

1. Verify your API key is valid
2. Check the endpoint URL is correct
3. Ensure the deployment exists

### "Model not found"

1. Verify the deployment name matches your Azure OpenAI resource
2. Check the model is deployed in the Azure portal
3. Ensure the deployment is in the same region as your endpoint

### Token Refresh Issues

Keyless authentication tokens are automatically refreshed. If you encounter issues:

1. Re-run `openclaw models auth login --provider azure-openai --method keyless`
2. Check Azure AD token lifetime settings
3. Verify network connectivity to Azure AD

## References

- [Azure OpenAI Documentation](https://learn.microsoft.com/en-us/azure/ai-services/openai/)
- [Keyless Authentication Guide](https://learn.microsoft.com/en-us/azure/developer/ai/keyless-connections?tabs=javascript%2Cazure-cli#use-defaultazurecredential)
- [Azure RBAC Roles](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/role-based-access-control)
- [DefaultAzureCredential Class](https://learn.microsoft.com/en-us/javascript/api/@azure/identity/defaultazurecredential)
