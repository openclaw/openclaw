# OpenClaw – Serverless Azure Function Deployment

This directory contains a standalone Azure Function App that runs OpenClaw as a
stateless, serverless webhook handler. It is designed for the **lowest possible
running cost** using the Azure Functions Consumption Plan.

## Architecture

```
Telegram ──▶ Azure Function (HTTP Trigger) ──▶ AI Provider (GitHub Copilot API)
                 │
                 ├── Azure Table Storage  (memory / embeddings)
                 ├── Azure Blob Storage   (session state)
                 └── Azure Key Vault      (secrets)
```

- **Stateless**: The function wakes only when a webhook arrives (no long-running
  gateway process).
- **Azure Table Storage**: Replaces the local SQLite database for memory and
  embedding cache persistence.
- **Azure Blob Storage**: Stores WhatsApp / Telegram session state so it
  survives across ephemeral function invocations.
- **Azure Key Vault**: Holds the `GITHUB_TOKEN` (referenced from App Settings).

## Prerequisites

- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
- [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local)
- Node.js 22+

## Quick Start (Local)

```bash
# 1. Copy sample settings
cp local.settings.sample.json local.settings.json
# 2. Edit local.settings.json with your tokens
# 3. Install dependencies
npm install
# 4. Build & run
npm start
```

## Deploy to Azure

```bash
# 1. Create a resource group
az group create --name rg-openclaw --location eastus

# 2. Deploy infrastructure (Function App + Storage + Key Vault)
az deployment group create \
  --resource-group rg-openclaw \
  --template-file ../infra/main.bicep \
  --parameters githubToken='<YOUR_GITHUB_TOKEN>'

# 3. Deploy the function code
func azure functionapp publish func-openclaw-dev

# 4. Set the Telegram webhook to point at your function
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://func-openclaw-dev.azurewebsites.net/api/telegram-webhook&secret_token=<SECRET>"
```

## Environment Variables

| Variable | Description | Source |
|----------|-------------|--------|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token | App Settings |
| `TELEGRAM_WEBHOOK_SECRET` | Secret for webhook validation | App Settings |
| `GITHUB_TOKEN` | GitHub Copilot API token | Key Vault reference |
| `AZURE_STORAGE_CONNECTION_STRING` | Storage account connection | Auto-set by Bicep |
| `OPENCLAW_AGENT_ID` | Agent identifier | App Settings (default: `"default"`) |

## Project Structure

```
azure-function/
├── src/
│   ├── functions/
│   │   └── webhook.ts          # HTTP trigger entry point
│   └── storage/
│       └── session-store-azure.ts  # Azure Blob session persistence
├── host.json                   # Azure Functions host configuration
├── package.json
├── tsconfig.json
└── local.settings.sample.json  # Template for local development
```

## Related Files

- `../infra/main.bicep` – Bicep template for one-click Azure deployment
- `../src/memory/memory-provider-azure.ts` – Azure Table Storage memory provider
