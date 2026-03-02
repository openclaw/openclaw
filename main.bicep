@description('Location for all resources.')
param location string = resourceGroup().location

@description('Name of the Container Apps Environment.')
param environmentName string = 'openclaw-workspace-env'

@description('Name of the OpenClaw Container App.')
param containerAppName string = 'openclaw-gateway'

@description('The full image tag from GitHub Actions (e.g., myacr.azurecr.io/my-openclaw:abc1234).')
param containerImage string

@description('The ACR login server (e.g., myacr.azurecr.io).')
param registryServer string

@description('The ACR username (usually the registry name).')
param registryUsername string

@description('The ACR password.')
@secure()
param registryPassword string

@description('Your static token to lock down the OpenClaw dashboard.')
@secure()
param openclawStaticToken string

@description('OpenAI API Key for the execution model')
@secure()
param openAiApiKey string

@description('Anthropic API Key for the reasoning model')
@secure()
param anthropicApiKey string

@description('Gemini API Key for web search grounding')
@secure()
param geminiApiKey string

@description('Slack App Token (starts with xapp-) for socket mode')
@secure()
param slackAppToken string

@description('Slack Bot Token (starts with xoxb-) for bot actions')
@secure()
param slackBotToken string

// 1. Log Analytics Workspace
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: '${environmentName}-logs'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

// 2. Storage Account for Persistent Memory
resource storageAccount 'Microsoft.Storage/storageAccounts@2022-09-01' = {
  name: 'ocdata${uniqueString(resourceGroup().id)}'
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
}

// 3. Azure File Share (The "Trailer")
resource fileShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2022-09-01' = {
  name: '${storageAccount.name}/default/openclaw-workspace'
}

// 4. Container Apps Environment
resource containerAppEnv 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }

  // Register the File Share to the Environment
  resource storage 'storages@2023-05-01' = {
    name: 'openclaw-mount'
    dependsOn: [
      fileShare // Prevents the race condition
    ]
    properties: {
      azureFile: {
        accountName: storageAccount.name
        accountKey: storageAccount.listKeys().keys[0].value
        shareName: 'openclaw-workspace'
        accessMode: 'ReadWrite'
      }
    }
  }
}

// 5. The OpenClaw Gateway Container App
resource openclawApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: containerAppName
  location: location
  dependsOn: [
    containerAppEnv::storage
  ]
  properties: {
    managedEnvironmentId: containerAppEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 18789
      }
      secrets: [
        {
          name: 'acr-password'
          value: registryPassword
        }
        {
          name: 'gateway-token'
          value: openclawStaticToken
        }
        {
          name: 'openai-api-key'
          value: openAiApiKey
        }
        {
          name: 'anthropic-api-key'
          value: anthropicApiKey
        }
        {
          name: 'gemini-api-key'
          value: geminiApiKey
        }
        {
          name: 'slack-app-token'
          value: slackAppToken
        }
        {
          name: 'slack-bot-token'
          value: slackBotToken
        }
      ]
      registries: [
        {
          server: registryServer
          username: registryUsername
          passwordSecretRef: 'acr-password'
        }
      ]
    }
    template: {
      volumes: [
        {
          name: 'openclaw-volume'
          storageType: 'AzureFile'
          storageName: 'openclaw-mount'
        }
      ]
      containers: [
        {
          name: 'openclaw-core'
          image: containerImage
          command: [
            '/bin/sh'
          ]
          args: [
            '-c'
            '''
cat << 'EOF' > /tmp/patch.js
const fs = require('fs');
['chmod', 'fchmod', 'chown', 'fchown'].forEach(f => {
  fs[f] = (...args) => { const cb = args.pop(); if (typeof cb === 'function') cb(null); };
  fs[f + 'Sync'] = () => {};
  if (fs.promises && fs.promises[f]) fs.promises[f] = async () => {};
});
EOF
mkdir -p /home/node/.openclaw/workspace
cat << 'AGENTS_EOF' > /home/node/.openclaw/workspace/AGENTS.md
# Agent Instructions

You are a helpful enterprise assistant.

## CITATION & FORMATTING RULES
When you call `web_search`, the tool result JSON contains a `citations` array with `url` and `title` fields, AND the content text ends with a numbered "References:" section. You MUST use these URLs as clickable links in your response. NEVER omit them.

**How to format links (check the Runtime channel= line in your system prompt):**
* If channel is **slack**: Use Slack link syntax exactly: `<URL|[1]>` — e.g. `<https://example.com|[1]>`
* If channel is **wecom**: Use Markdown link syntax: `[[1]](URL)`
* For **all other channels**: Use standard Markdown: `[1](URL)`

**Rules:**
1. Every factual claim from web_search MUST have at least one citation link.
2. Place citation links inline at the end of the relevant sentence or paragraph.
3. Prefer URLs from the `citations` array (they are resolved/clean URLs).
4. If `citations` is empty, use URLs from the References section in the content.
AGENTS_EOF
node --require /tmp/patch.js openclaw.mjs config set gateway.trustedProxies '["0.0.0.0/0", "::/0"]'
node --require /tmp/patch.js openclaw.mjs config set gateway.controlUi.allowedOrigins "[\"$OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS\"]"
node --require /tmp/patch.js openclaw.mjs config set channels.slack.enabled true
node --require /tmp/patch.js openclaw.mjs config set channels.slack.dmPolicy '"open"'
node --require /tmp/patch.js openclaw.mjs config set channels.slack.allowFrom '["*"]'
node --require /tmp/patch.js openclaw.mjs config set channels.slack.groupPolicy '"open"'
exec node --require /tmp/patch.js openclaw.mjs gateway --allow-unconfigured --bind lan
            '''
          ]
          env: [
            // Core Security
            {
              name: 'OPENCLAW_GATEWAY_AUTH_TOKEN'
              secretRef: 'gateway-token'
            }
            {
              name: 'OPENCLAW_CONTROL_UI_ALLOW_INSECURE_AUTH'
              value: 'true' // Bypasses the device pairing waiting room
            }

            // Slack Integration
            {
              name: 'SLACK_BOT_TOKEN'
              secretRef: 'slack-bot-token'
            }
            {
              name: 'SLACK_APP_TOKEN'
              secretRef: 'slack-app-token'
            }

            // LLM API Keys
            {
              name: 'OPENAI_API_KEY'
              secretRef: 'openai-api-key'
            }
            {
              name: 'ANTHROPIC_API_KEY'
              secretRef: 'anthropic-api-key'
            }
            {
              name: 'GEMINI_API_KEY'
              secretRef: 'gemini-api-key'
            }

            // Model Routing Assignments
            {
              name: 'OPENCLAW_AGENTS_DEFAULTS_MODEL_PRIMARY'
              value: 'anthropic/claude-opus-4-6' // Deep Thinking Brain
            }
            {
              name: 'OPENCLAW_AGENTS_DEFAULTS_MODEL_FAST'
              value: 'openai/gpt-5-mini' // Fast Execution Brain
            }

            // UI Origin Configuration
            {
              name: 'OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS'
              // Dynamically whitelist the Azure Container App's own default hostname
              value: 'https://${containerAppName}.${containerAppEnv.properties.defaultDomain}'
            }
          ]
          volumeMounts: [
            {
              volumeName: 'openclaw-volume'
              mountPath: '/home/node/.openclaw'
            }
          ]
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}
