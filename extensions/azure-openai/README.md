# Azure OpenAI Provider Plugin

This plugin adds Azure OpenAI support to OpenClaw with two authentication methods:

1. **API Key**: Traditional API key authentication
2. **Keyless**: Azure managed identity or service principal using `DefaultAzureCredential`

## Features

- Support for all Azure OpenAI models (GPT-4, GPT-4o, GPT-3.5-turbo, o1, etc.)
- Two authentication methods: API key and keyless
- Automatic token refresh for keyless authentication
- Configurable deployments per model

## Installation

This plugin is bundled with OpenClaw. No separate installation required.

## Authentication

### Method 1: API Key

Use this method if you have an Azure OpenAI API key.

```bash
openclaw models auth login --provider azure-openai --method api-key
```

You'll be prompted for:

- Azure OpenAI endpoint URL (e.g., `https://your-resource-name.openai.azure.com`)
- Deployment name (optional)
- API key

### Method 2: Keyless (DefaultAzureCredential)

Use this method for Azure managed identity or service principal authentication.

```bash
openclaw models auth login --provider azure-openai --method keyless
```

You'll be prompted for:

- Azure OpenAI endpoint URL
- Deployment name (optional)

The plugin will automatically use credentials from:

1. Environment variables (`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`)
2. Azure CLI (`az login`)
3. Managed identity (if running on Azure)

## Configuration

### Environment Variables

#### For API Key Authentication:

- `AZURE_OPENAI_API_KEY`: Your Azure OpenAI API key
- `AZURE_OPENAI_ENDPOINT`: Your Azure OpenAI endpoint URL
- `AZURE_OPENAI_DEPLOYMENT_NAME`: Default deployment name

#### For Keyless Authentication:

- `AZURE_CLIENT_ID`: Service principal client ID
- `AZURE_CLIENT_SECRET`: Service principal client secret
- `AZURE_TENANT_ID`: Azure AD tenant ID

### Manual Configuration

You can also manually configure the provider in your `config.json`:

```json
{
  "models": {
    "providers": {
      "azure-openai": {
        "baseUrl": "https://your-resource-name.openai.azure.com/openai/deployments/gpt-4o",
        "api": "openai-completions",
        "apiKey": "AZURE_OPENAI_API_KEY",
        "headers": {
          "api-key": "${AZURE_OPENAI_API_KEY}"
        },
        "models": [
          {
            "id": "gpt-4o",
            "name": "GPT-4o",
            "reasoning": false,
            "input": ["text", "image"],
            "cost": {
              "input": 2.5,
              "output": 10,
              "cacheRead": 1.25,
              "cacheWrite": 2.5
            },
            "contextWindow": 128000,
            "maxTokens": 16384
          }
        ]
      }
    }
  }
}
```

## Azure RBAC Permissions

For keyless authentication, ensure your Azure identity has the **Cognitive Services OpenAI User** role:

```bash
az role assignment create \
  --role "Cognitive Services OpenAI User" \
  --assignee <your-user-or-service-principal-id> \
  --scope /subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.CognitiveServices/accounts/<openai-resource-name>
```

## Supported Models

The plugin includes configurations for:

- GPT-4o and GPT-4o mini
- GPT-4 and GPT-4 Turbo
- GPT-3.5 Turbo
- o1-preview and o1-mini (reasoning models)

You can customize model definitions in your configuration or add additional deployments.

## Reference

- [Azure OpenAI documentation](https://learn.microsoft.com/en-us/azure/ai-services/openai/)
- [Keyless authentication with DefaultAzureCredential](https://learn.microsoft.com/en-us/azure/developer/ai/keyless-connections?tabs=javascript%2Cazure-cli#use-defaultazurecredential)
- [Azure RBAC roles](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/role-based-access-control)
