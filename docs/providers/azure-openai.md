---
summary: "Use Azure OpenAI models in OpenClaw"
read_when:
  - You want to use Azure OpenAI deployments in OpenClaw
  - You need to configure a custom endpoint and deployment name
title: "Azure OpenAI"
---

# Azure OpenAI

OpenClaw supports Azure OpenAI via the `azure-openai-responses` API adapter, which uses the OpenAI Responses API through the Azure SDK (`AzureOpenAI` client from the `openai` npm package).

## Configuration

Add the following to your `openclaw.json` (or `config.json`):

```json5
{
  models: {
    providers: {
      azure: {
        // Your Azure OpenAI resource base URL
        baseUrl: "https://YOUR_RESOURCE_NAME.openai.azure.com/openai/v1",

        // Use the specialized Azure adapter (Responses API)
        api: "azure-openai-responses",

        // Your Azure API key
        apiKey: "YOUR_AZURE_API_KEY",

        // Define the models available on this deployment
        models: [
          {
            id: "gpt-4o",
            name: "gpt-4o",
          },
        ],
      },
    },
  },
}
```

### Azure-specific options

The adapter supports several Azure-specific options, configurable via environment variables:

| Environment variable               | Description                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `AZURE_OPENAI_API_KEY`             | API key (fallback when `apiKey` is not set in config)                                     |
| `AZURE_OPENAI_BASE_URL`            | Base URL for the Azure OpenAI resource                                                    |
| `AZURE_OPENAI_RESOURCE_NAME`       | Resource name (used to build the base URL as `https://{name}.openai.azure.com/openai/v1`) |
| `AZURE_OPENAI_API_VERSION`         | API version string (default: `v1`)                                                        |
| `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` | Comma-separated `modelId=deploymentName` mappings (e.g. `gpt-4o=my-gpt4o,gpt-4=my-gpt4`)  |

### How the adapter resolves the endpoint

1. If `baseUrl` is set in the provider config, it is used directly.
2. Otherwise, if `AZURE_OPENAI_BASE_URL` is set, that is used.
3. Otherwise, if `AZURE_OPENAI_RESOURCE_NAME` is set, the URL is built as `https://{resource}.openai.azure.com/openai/v1`.
4. If none of the above are set, an error is thrown.

The adapter uses the `AzureOpenAI` SDK class with `client.responses.create()` (the Responses API), not the Chat Completions API.

### Deployment name mapping

By default, the model `id` is used as the Azure deployment name. To override this:

- Set the `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` environment variable (e.g. `gpt-4o=my-custom-deployment`), or
- The adapter will use the model ID as-is.

## Usage

Once configured, use the model by referencing `provider/model-id`:

```bash
openclaw chat --model azure/gpt-4o
```
