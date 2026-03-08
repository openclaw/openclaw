---
summary: "Use Azure OpenAI Responses models in OpenClaw"
read_when:
  - You want to use Azure OpenAI with OpenClaw
  - You need v1 vs preview API version setup for Azure OpenAI
title: "Azure OpenAI"
---

# Azure OpenAI

Use Azure OpenAI through the built-in `azure-openai-responses` provider.

## Best for

- Enterprise deployments on Azure OpenAI.
- Teams that need Azure endpoint control and region-specific deployments.

## CLI setup

```bash
# Interactive
openclaw onboard --auth-choice azure-openai-api-key

# Non-interactive (default API version: v1)
openclaw onboard \
  --non-interactive --accept-risk \
  --auth-choice azure-openai-api-key \
  --azure-openai-api-key "$AZURE_OPENAI_API_KEY" \
  --azure-openai-base-url "https://<resource>.openai.azure.com" \
  --azure-openai-model-id "gpt-4.1"

# Non-interactive (preview API version)
openclaw onboard \
  --non-interactive --accept-risk \
  --auth-choice azure-openai-api-key \
  --azure-openai-api-key "$AZURE_OPENAI_API_KEY" \
  --azure-openai-base-url "https://<resource>.cognitiveservices.azure.com" \
  --azure-openai-model-id "gpt-5.4" \
  --azure-openai-api-version "2025-04-01-preview"
```

## Required flags

- `--azure-openai-api-key`
- `--azure-openai-base-url`
- `--azure-openai-model-id` (Azure deployment/model id)

## Optional flags

- `--azure-openai-api-version`
  - default: `v1`
  - set a preview string (for example `2025-04-01-preview`) when your Azure endpoint requires it

## Base URL rules

OpenClaw accepts Azure hosts under:

- `*.openai.azure.com`
- `*.services.ai.azure.com`
- `*.cognitiveservices.azure.com`

OpenClaw normalizes the configured endpoint to `.../openai/v1`.

## v1 vs preview behavior

- `v1` mode: no extra API version override is needed.
- `preview` mode: pass `--azure-openai-api-version`; OpenClaw stores the override in model params and forwards it to the Azure client.

## Config snippet

```json5
{
  agents: {
    defaults: {
      model: { primary: "azure-openai-responses/gpt-5.4" },
      models: {
        "azure-openai-responses/gpt-5.4": {
          params: {
            azureApiVersion: "2025-04-01-preview",
          },
        },
      },
    },
  },
  models: {
    providers: {
      "azure-openai-responses": {
        baseUrl: "https://<resource>.cognitiveservices.azure.com/openai/v1",
        api: "openai-responses",
        apiKey: "${AZURE_OPENAI_API_KEY}",
        models: [
          {
            id: "gpt-5.4",
            name: "Azure OpenAI gpt-5.4",
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
            compat: { supportsStore: false },
          },
        ],
      },
    },
  },
}
```

## Model IDs

- Use the deployment/model id configured in your Azure resource.
- A common example is `gpt-5.4` when deployed in your tenant.
