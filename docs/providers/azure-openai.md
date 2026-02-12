---
summary: "Use Azure OpenAI models in OpenClaw"
read_when:
  - You want to use Azure OpenAI deployments in OpenClaw
  - You need to configure a custom endpoint and deployment name
title: "Azure OpenAI"
---

# Azure OpenAI

OpenClaw supports Azure OpenAI via custom provider configuration. You can connect to your Azure OpenAI resource by specifying the endpoint, API key, and deployment details.

## Configuration

Add the following to your `openclaw.json` (or `config.json`):

```json5
{
  models: {
    providers: {
      azure: {
        // Your Azure OpenAI Endpoint
        baseUrl: "https://YOUR_RESOURCE_NAME.openai.azure.com/openai/deployments/YOUR_DEPLOYMENT_NAME",

        // Use the specialized Azure adapter
        api: "azure-openai-responses",

        // Your Azure API Key (not the OpenAI 'sk-' key)
        apiKey: "YOUR_AZURE_API_KEY",

        // Define the models available on this deployment
        models: [
          {
            id: "gpt-4",
            name: "gpt-4", // or your deployment name if different
          },
        ],
      },
    },
  },
}
```

### Important Notes on URLs

Azure OpenAI URLs typically follow this pattern:
`https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version={version}`

OpenClaw's `azure-openai-responses` adapter expects the `baseUrl` to be the deployment root. It will append `/chat/completions` and the API version parameters automatically, or you can specify the full path if needed depending on your specific setup.

If you need to strictly control the URL or headers:

```json5
{
  models: {
    providers: {
      "azure-custom": {
        baseUrl: "https://YOUR_RESOURCE.openai.azure.com/openai/deployments/YOUR_DEPLOYMENT",
        // Fallback to generic OpenAI if the Azure adapter doesn't match your version needs
        api: "openai-responses",
        apiKey: "YOUR_KEY",
        headers: {
          "api-key": "YOUR_KEY", // Azure requires this header if not using Bearer
        },
      },
    },
  },
}
```

## Usage

Once configured, you can use the model by referencing `provider/model-id`:

```bash
openclaw chat --model azure/gpt-4
```
