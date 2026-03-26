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

@description('JSON array of Slack member IDs allowed to interact with the bot (e.g., \'["U12345","U67890"]\').')
param slackAllowedMembers string = '["*"]'

// 1. Log Analytics Workspace
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: '${environmentName}-logs'
  location: location
  tags: {
    Component: 'OpenClaw'
  }
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
  tags: {
    Component: 'OpenClaw'
  }
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
  tags: {
    Component: 'OpenClaw'
  }
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
  tags: {
    Component: 'OpenClaw'
  }
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
# Pre-create SOUL.md and USER.md so the personal-assistant templates are not scaffolded.
cat << 'SOUL_EOF' > /home/node/.openclaw/workspace/SOUL.md
# Enterprise Assistant
Helpful, concise, and citation-accurate. No persona or personal relationship framing.
SOUL_EOF
cat << 'USER_EOF' > /home/node/.openclaw/workspace/USER.md
# Shared Enterprise Workspace
Multi-user deployment — no single user profile.
USER_EOF
# Pre-create BOOTSTRAP.md (empty) so the onboarding wizard is not injected into context.
touch /home/node/.openclaw/workspace/BOOTSTRAP.md
# Activate memory curation: add a non-empty task to HEARTBEAT.md so the LLM call runs.
# Without this, the heartbeat runner fires every 30m but skips the API call because the
# default template is all markdown headers (treated as comments by isHeartbeatContentEffectivelyEmpty).
cat << 'HEARTBEAT_EOF' > /home/node/.openclaw/workspace/HEARTBEAT.md
# Periodic memory curation
- Check the memory/ directory for date-stamped files (memory/YYYY-MM-DD.md) written since last curation.
- If new entries exist, distill key facts, decisions, and patterns into MEMORY.md (create if absent).
- Keep MEMORY.md concise: facts and decisions only, no raw transcript. Append; never overwrite existing entries.
- If nothing new to curate, reply HEARTBEAT_OK.
HEARTBEAT_EOF
node --require /tmp/patch.js openclaw.mjs config set gateway.trustedProxies '["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]'
node --require /tmp/patch.js openclaw.mjs config set gateway.controlUi.allowedOrigins "[\"$OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS\"]"
node --require /tmp/patch.js openclaw.mjs config set channels.slack.enabled true
node --require /tmp/patch.js openclaw.mjs config set channels.slack.dmPolicy '"open"'
node --require /tmp/patch.js openclaw.mjs config set channels.slack.allowFrom "$OPENCLAW_SLACK_ALLOWED_MEMBERS"
node --require /tmp/patch.js openclaw.mjs config set channels.slack.groupPolicy '"open"'
node --require /tmp/patch.js openclaw.mjs config set tools.profile full
node --require /tmp/patch.js openclaw.mjs mcp set rag-search '{"url":"https://retrieval-mcp-server.internal.lemonforest-578b1773.eastus.azurecontainerapps.io/mcp","transport":"streamable-http"}'
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
              value: 'false' // Requires gateway-token auth via the Control UI
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

            // Slack Access Control
            {
              name: 'OPENCLAW_SLACK_ALLOWED_MEMBERS'
              value: slackAllowedMembers
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
