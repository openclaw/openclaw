---
summary: "Use Azure AI Foundry models (Anthropic Claude & OpenAI GPT) with OpenClaw"
read_when:
  - You want to use Azure AI Foundry models in OpenClaw
  - You need to connect Anthropic Claude models via Azure
  - You need to connect OpenAI GPT models via Azure AI Foundry
title: "Azure AI Foundry"
---

# Azure AI Foundry

[Azure AI Foundry](https://ai.azure.com/) hosts models from multiple providers
(Anthropic, OpenAI, Meta, Mistral, etc.) behind a single Azure endpoint. OpenClaw
supports two API adapters for Foundry, depending on which model family you deploy:

| Model family | API adapter              | Base URL suffix | Auth header |
| ------------ | ------------------------ | --------------- | ----------- |
| Anthropic    | `anthropic-messages`     | `/anthropic/`   | `x-api-key` |
| OpenAI       | `azure-openai-responses` | `/openai`       | `api-key`   |

<Note>
Azure AI Foundry uses **deployment names** as model IDs. The deployment name may
differ from the upstream model name (e.g. `claude-sonnet-4-6` instead of
`claude-sonnet-4-5-20250514`). Check your Foundry portal for the exact deployment
name.
</Note>

## Prerequisites

1. An [Azure AI Foundry](https://ai.azure.com/) resource with at least one model deployed.
2. Your resource endpoint URL (e.g. `https://<resource>-<region>.services.ai.azure.com`).
3. An API key from the Foundry portal (**Keys and Endpoint** section).

## Getting started

<Tabs>
  <Tab title="Anthropic (Claude)">
    **Best for:** Claude models deployed on Azure AI Foundry.

    <Steps>
      <Step title="Verify the deployment works">
        Test with curl before configuring OpenClaw:

        ```bash
        curl -s "https://<resource>.services.ai.azure.com/anthropic/v1/messages" \
          -H "x-api-key: $AZURE_API_KEY" \
          -H "anthropic-version: 2023-06-01" \
          -H "content-type: application/json" \
          -d '{
            "model": "<deployment-name>",
            "max_tokens": 10,
            "messages": [{"role": "user", "content": "hello"}]
          }'
        ```

        A 200 response confirms the deployment is live.
      </Step>
      <Step title="Add the provider to your config">
        In `~/.openclaw/openclaw.json`, add a provider under `models.providers`:

        ```json5
        {
          models: {
            providers: {
              "azure-foundry": {
                // IMPORTANT: use /anthropic/ — do NOT append /v1 (the adapter adds it)
                baseUrl: "https://<resource>.services.ai.azure.com/anthropic/",
                auth: "api-key",
                api: "anthropic-messages",
                models: [
                  {
                    id: "claude-sonnet-4-6",       // use the deployment name
                    name: "Claude Sonnet 4.6 (Azure Foundry)",
                    api: "anthropic-messages",
                    reasoning: true,
                    input: ["text", "image"],
                    contextWindow: 200000,
                    maxTokens: 16384,
                  },
                ],
              },
            },
          },
        }
        ```

        <Warning>
        The `baseUrl` must end with `/anthropic/` (no `/v1`). The
        `anthropic-messages` adapter appends the API path automatically. Using
        `/anthropic/v1` causes double-pathing (`/anthropic/v1/v1/messages`).
        </Warning>
      </Step>
      <Step title="Add auth credentials">
        Add an auth profile to your agent's `auth-profiles.json`:

        ```json
        {
          "version": 1,
          "profiles": {
            "azure-foundry:manual": {
              "type": "token",
              "provider": "azure-foundry",
              "token": "<your-azure-api-key>"
            }
          }
        }
        ```

        And reference it in `openclaw.json`:

        ```json5
        {
          auth: {
            profiles: {
              "azure-foundry:manual": {
                provider: "azure-foundry",
                mode: "token",
              },
            },
          },
        }
        ```

        <Note>
        The auth profile `type` must be `"token"` — not `"api-key"`. OpenClaw's
        auth store only accepts `"token"`, `"oauth"`, or `"api_key"` as valid
        types. The provider-level `auth: "api-key"` setting controls which HTTP
        header is used, not the storage type.
        </Note>
      </Step>
      <Step title="Set as default model (optional)">
        ```json5
        {
          agents: {
            defaults: {
              models: { "azure-foundry/claude-sonnet-4-6": {} },
              model: { primary: "azure-foundry/claude-sonnet-4-6" },
            },
          },
        }
        ```
      </Step>
      <Step title="Restart and verify">
        ```bash
        openclaw gateway restart
        openclaw models status
        ```

        Expected output includes:

        ```
        Providers w/ OAuth/tokens (1): azure-foundry (1)
        - azure-foundry effective=profiles:...auth-profiles.json
        ```
      </Step>
    </Steps>

  </Tab>

  <Tab title="OpenAI (GPT)">
    **Best for:** GPT models deployed on Azure AI Foundry.

    <Steps>
      <Step title="Verify the deployment works">
        ```bash
        curl -s "https://<resource>.services.ai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=2024-12-01-preview" \
          -H "api-key: $AZURE_API_KEY" \
          -H "content-type: application/json" \
          -d '{
            "messages": [{"role": "user", "content": "hello"}],
            "max_tokens": 10
          }'
        ```
      </Step>
      <Step title="Add the provider to your config">
        ```json5
        {
          models: {
            providers: {
              "azure-openai-foundry": {
                baseUrl: "https://<resource>.services.ai.azure.com/openai",
                auth: "api-key",
                api: "azure-openai-responses",
                models: [
                  {
                    id: "gpt-4o",               // use the deployment name
                    name: "GPT-4o (Azure Foundry)",
                    api: "azure-openai-responses",
                    reasoning: false,
                    input: ["text", "image"],
                    contextWindow: 128000,
                    maxTokens: 16384,
                  },
                ],
              },
            },
          },
        }
        ```

        <Tip>
        The `azure-openai-responses` adapter handles `api-version` query
        parameters and deployment-name mapping automatically via the `AzureOpenAI`
        SDK client. You can set `AZURE_OPENAI_API_VERSION` to override the default
        API version.
        </Tip>
      </Step>
      <Step title="Add auth and set default">
        Follow the same auth profile pattern as the Anthropic tab above, using
        `"azure-openai-foundry"` as the provider name.
      </Step>
      <Step title="Restart and verify">
        ```bash
        openclaw gateway restart
        openclaw models status
        ```
      </Step>
    </Steps>

  </Tab>
</Tabs>

## Adapter comparison

| Feature         | `anthropic-messages`       | `azure-openai-responses`  |
| --------------- | -------------------------- | ------------------------- |
| SDK client      | Anthropic SDK              | AzureOpenAI SDK           |
| Base URL suffix | `/anthropic/`              | `/openai`                 |
| Auth header     | `x-api-key: <key>`         | `api-key: <key>`          |
| Model field     | Deployment name directly   | Deployment-name mapping   |
| API version     | `anthropic-version` header | `api-version` query param |
| Streaming       | SSE                        | SSE                       |

## Troubleshooting

<AccordionGroup>
  <Accordion title="404 DeploymentNotFound">
    The model deployment name doesn't match what Azure expects. Check in the
    [Azure AI Foundry portal](https://ai.azure.com/) under **Deployments** for
    the exact name.
  </Accordion>
  <Accordion title="Missing auth after gateway restart">
    Verify your `auth-profiles.json` uses `"type": "token"` (not `"type": "api-key"`).
    Run `openclaw models status` and confirm the provider appears under
    **Providers w/ OAuth/tokens**.
  </Accordion>
  <Accordion title="Context overflow / prompt too large">
    Azure Foundry enforces the same context limits as the upstream model. If you
    see `context-overflow-precheck` errors, start a new session (`/new` on
    Telegram) or enable compaction in your config:

    ```json5
    { agents: { defaults: { compaction: { mode: "safeguard" } } } }
    ```

  </Accordion>
  <Accordion title="Double-path in URL (e.g. /v1/v1/messages)">
    Your `baseUrl` likely includes `/v1`. Remove it — the adapter appends the
    correct API path. Use `https://...services.ai.azure.com/anthropic/` (not
    `.../anthropic/v1`).
  </Accordion>
</AccordionGroup>

## Environment variables

| Variable                           | Description                                   |
| ---------------------------------- | --------------------------------------------- |
| `AZURE_OPENAI_API_VERSION`         | Override default API version (OpenAI adapter) |
| `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` | Custom model-to-deployment mapping (OpenAI)   |
| `AZURE_OPENAI_BASE_URL`            | Override base URL (OpenAI adapter)            |
