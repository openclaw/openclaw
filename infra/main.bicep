@description('Environment name used by Azure Developer CLI.')
param environmentName string

@description('Primary Azure region for all resources in this deployment.')
param location string = resourceGroup().location

@description('Administrator username for Azure Database for PostgreSQL.')
param postgresAdminLogin string = 'alpacoreadmin'

@secure()
@description('Administrator password for Azure Database for PostgreSQL.')
param postgresAdminPassword string

@description('Application database name for the AlpaCore services.')
param postgresDatabaseName string = 'alpacoredb'

@description('Fallback image used when a service-specific image is not supplied yet.')
param baseContainerImage string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

@description('Built OpenClaw image reference. Leave empty to provision with the fallback image until azd deploy pushes the real image.')
param openClawImage string = ''

@description('Image reference for the AlpaCore Engine workload.')
param alpaEngineImage string = ''

@description('Image reference for the supporting AlpaCore service workload.')
param alpaCoreServiceImage string = ''

@description('Image reference for Open WebUI.')
param openWebUiImage string = 'ghcr.io/open-webui/open-webui:main'

@description('Cloud-reachable Ollama endpoint kept outside Azure Container Apps.')
param externalOllamaUrl string = 'http://replace-me.example.com:11434'

@secure()
@description('Shared-secret token for the OpenClaw gateway admin surface.')
param openClawGatewayToken string = ''

@secure()
@description('Secret key for Open WebUI sessions.')
param webUiSecretKey string = ''

@secure()
@description('Optional OpenAI API key used by Open WebUI.')
param openAiApiKey string = ''

@description('Optional Revolut client ID consumed by the AlpaCore Engine.')
param revolutClientId string = ''

@secure()
@description('Optional Revolut client secret consumed by the AlpaCore Engine.')
param revolutClientSecret string = ''

@secure()
@description('Optional Telegram bot token consumed by the AlpaCore Engine.')
param telegramBotToken string = ''

@description('Timezone for the OpenClaw gateway container.')
param openClawTimezone string = 'UTC'

@description('Disable Bonjour in containerized OpenClaw deployments unless a private network explicitly needs it.')
param openClawDisableBonjour string = '1'

var resourceToken = uniqueString(subscription().id, resourceGroup().id, location, environmentName)
var commonTags = {
  'azd-env-name': environmentName
  'azd-project-name': 'openclaw'
}

var logAnalyticsWorkspaceName = 'azlaw${resourceToken}'
var managedEnvironmentName = 'azcae${resourceToken}'
var containerRegistryName = 'azacr${resourceToken}'
var userAssignedIdentityName = 'azid${resourceToken}'
var keyVaultName = 'azkv${resourceToken}'
var postgresServerName = 'azpg${resourceToken}'
var openClawContainerAppName = 'azocg${resourceToken}'
var alpaEngineContainerAppName = 'azeng${resourceToken}'
var alpaCoreServiceContainerAppName = 'azsvc${resourceToken}'
var openWebUiContainerAppName = 'azwui${resourceToken}'

var openClawImageRef = empty(openClawImage) ? baseContainerImage : openClawImage
var alpaEngineImageRef = empty(alpaEngineImage) ? baseContainerImage : alpaEngineImage
var alpaCoreServiceImageRef = empty(alpaCoreServiceImage) ? baseContainerImage : alpaCoreServiceImage
var openWebUiImageRef = empty(openWebUiImage) ? baseContainerImage : openWebUiImage
var postgresConnectionString = 'Host=${postgresServer.properties.fullyQualifiedDomainName};Port=5432;Database=${postgresDatabaseName};Username=${postgresAdminLogin};Password=${postgresAdminPassword};Ssl Mode=Require;Trust Server Certificate=false;'
var openClawSecretDefinitions = empty(openClawGatewayToken)
  ? []
  : [
      {
        name: 'openclaw-gateway-token'
        value: openClawGatewayToken
      }
    ]
var openClawEnv = concat([
  {
    name: 'TZ'
    value: openClawTimezone
  }
  {
    name: 'OPENCLAW_DISABLE_BONJOUR'
    value: openClawDisableBonjour
  }
  {
    name: 'OPENCLAW_GATEWAY_BIND'
    value: 'lan'
  }
  {
    name: 'OPENCLAW_PLUGIN_STAGE_DIR'
    value: '/var/lib/openclaw/plugin-runtime-deps'
  }
  {
    name: 'OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS'
    value: '["https://${openClawContainerAppName}.${managedEnvironment.properties.defaultDomain}","http://${openClawContainerAppName}.${managedEnvironment.properties.defaultDomain}"]'
  }
], empty(openClawGatewayToken)
  ? []
  : [
      {
        name: 'OPENCLAW_GATEWAY_TOKEN'
        secretRef: 'openclaw-gateway-token'
      }
    ])
var alpaEngineSecretDefinitions = concat([
  {
    name: 'postgres-admin-password'
    value: postgresAdminPassword
  }
], empty(revolutClientSecret)
  ? []
  : [
      {
        name: 'revolut-client-secret'
        value: revolutClientSecret
      }
    ], empty(telegramBotToken)
  ? []
  : [
      {
        name: 'telegram-bot-token'
        value: telegramBotToken
      }
    ])
var alpaEngineEnv = concat([
  {
    name: 'ASPNETCORE_ENVIRONMENT'
    value: 'Production'
  }
  {
    name: 'ASPNETCORE_URLS'
    value: 'http://+:8080'
  }
  {
    name: 'ASPNETCORE_HTTP_PORTS'
    value: '8080'
  }
  {
    name: 'DATABASE_HOST'
    value: postgresServer.properties.fullyQualifiedDomainName
  }
  {
    name: 'DATABASE_PORT'
    value: '5432'
  }
  {
    name: 'DATABASE_NAME'
    value: postgresDatabaseName
  }
  {
    name: 'DATABASE_USER'
    value: postgresAdminLogin
  }
  {
    name: 'DATABASE_PASSWORD'
    secretRef: 'postgres-admin-password'
  }
  {
    name: 'OLLAMA_HOST'
    value: externalOllamaUrl
  }
  {
    name: 'HTTP_TIMEOUT'
    value: '60'
  }
  {
    name: 'OLLAMA_TIMEOUT'
    value: '60000'
  }
], empty(revolutClientId)
  ? []
  : [
      {
        name: 'REVOLUT_CLIENT_ID'
        value: revolutClientId
      }
    ], empty(revolutClientSecret)
  ? []
  : [
      {
        name: 'REVOLUT_CLIENT_SECRET'
        secretRef: 'revolut-client-secret'
      }
    ], empty(telegramBotToken)
  ? []
  : [
      {
        name: 'TELEGRAM_BOT_TOKEN'
        secretRef: 'telegram-bot-token'
      }
    ])
var openWebUiSecretDefinitions = concat(empty(webUiSecretKey)
  ? []
  : [
      {
        name: 'webui-secret-key'
        value: webUiSecretKey
      }
    ], empty(openAiApiKey)
  ? []
  : [
      {
        name: 'openai-api-key'
        value: openAiApiKey
      }
    ])
var openWebUiEnv = concat([
  {
    name: 'PORT'
    value: '8080'
  }
  {
    name: 'ENV'
    value: 'prod'
  }
  {
    name: 'OLLAMA_HOST'
    value: externalOllamaUrl
  }
  {
    name: 'OLLAMA_BASE_URL'
    value: externalOllamaUrl
  }
  {
    name: 'USE_OLLAMA_DOCKER'
    value: 'false'
  }
  {
    name: 'SCARF_NO_ANALYTICS'
    value: 'true'
  }
  {
    name: 'DO_NOT_TRACK'
    value: 'true'
  }
  {
    name: 'ANONYMIZED_TELEMETRY'
    value: 'false'
  }
], empty(webUiSecretKey)
  ? []
  : [
      {
        name: 'WEBUI_SECRET_KEY'
        secretRef: 'webui-secret-key'
      }
    ], empty(openAiApiKey)
  ? []
  : [
      {
        name: 'OPENAI_API_KEY'
        secretRef: 'openai-api-key'
      }
    ])

resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsWorkspaceName
  location: location
  tags: commonTags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: containerRegistryName
  location: location
  tags: commonTags
  sku: {
    name: 'Standard'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource userAssignedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: userAssignedIdentityName
  location: location
  tags: commonTags
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: commonTags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    softDeleteRetentionInDays: 90
  }
}

resource keyVaultSecretsOfficerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, userAssignedIdentity.id, 'KeyVaultSecretsOfficer')
  scope: keyVault
  properties: {
    principalId: userAssignedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
  }
}

resource keyVaultSecretsUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, userAssignedIdentity.id, 'KeyVaultSecretsUser')
  scope: keyVault
  properties: {
    principalId: userAssignedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresServerName
  location: location
  tags: commonTags
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    version: '17'
    storage: {
      storageSizeGB: 32
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
  }
}

resource postgresDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgresServer
  name: postgresDatabaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource postgresFirewallRule 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgresServer
  name: 'allowazureservices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource postgresAdminPasswordSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'postgres-admin-password'
  properties: {
    value: postgresAdminPassword
  }
  dependsOn: [
    keyVaultSecretsOfficerRole
  ]
}

resource postgresConnectionStringSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'postgres-connection-string'
  properties: {
    value: postgresConnectionString
  }
  dependsOn: [
    postgresDatabase
    keyVaultSecretsOfficerRole
  ]
}

resource openClawGatewayTokenSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(openClawGatewayToken)) {
  parent: keyVault
  name: 'openclaw-gateway-token'
  properties: {
    value: openClawGatewayToken
  }
  dependsOn: [
    keyVaultSecretsOfficerRole
  ]
}

resource webUiSecretKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(webUiSecretKey)) {
  parent: keyVault
  name: 'webui-secret-key'
  properties: {
    value: webUiSecretKey
  }
  dependsOn: [
    keyVaultSecretsOfficerRole
  ]
}

resource openAiApiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(openAiApiKey)) {
  parent: keyVault
  name: 'openai-api-key'
  properties: {
    value: openAiApiKey
  }
  dependsOn: [
    keyVaultSecretsOfficerRole
  ]
}

resource revolutClientSecretSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(revolutClientSecret)) {
  parent: keyVault
  name: 'revolut-client-secret'
  properties: {
    value: revolutClientSecret
  }
  dependsOn: [
    keyVaultSecretsOfficerRole
  ]
}

resource telegramBotTokenSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(telegramBotToken)) {
  parent: keyVault
  name: 'telegram-bot-token'
  properties: {
    value: telegramBotToken
  }
  dependsOn: [
    keyVaultSecretsOfficerRole
  ]
}

resource managedEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: managedEnvironmentName
  location: location
  tags: commonTags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsWorkspace.properties.customerId
        sharedKey: logAnalyticsWorkspace.listKeys().primarySharedKey
      }
    }
  }
}

resource acrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(containerRegistry.id, userAssignedIdentity.id, 'AcrPull')
  scope: containerRegistry
  properties: {
    principalId: userAssignedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

resource openClawContainerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: openClawContainerAppName
  location: location
  tags: union(commonTags, {
    'azd-service-name': 'openclaw'
  })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${userAssignedIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    configuration: {
      registries: [
        {
          server: '${containerRegistry.name}.azurecr.io'
          identity: userAssignedIdentity.id
        }
      ]
      ingress: {
        allowInsecure: true
        external: true
        targetPort: 18789
        transport: 'auto'
        corsPolicy: {
          allowedOrigins: [
            '*'
          ]
          allowedMethods: [
            'GET'
            'POST'
            'PUT'
            'PATCH'
            'DELETE'
            'OPTIONS'
          ]
          allowedHeaders: [
            '*'
          ]
          exposeHeaders: [
            '*'
          ]
          maxAge: 86400
        }
      }
      secrets: openClawSecretDefinitions
    }
    template: {
      containers: [
        {
          name: 'openclaw'
          image: openClawImageRef
          command: [
            'node'
          ]
          args: [
            'openclaw.mjs'
            'gateway'
            '--allow-unconfigured'
            '--bind'
            'lan'
            '--port'
            '18789'
          ]
          env: openClawEnv
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: 18789
              }
              initialDelaySeconds: 20
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/readyz'
                port: 18789
              }
              initialDelaySeconds: 20
              periodSeconds: 30
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
  dependsOn: [
    acrPullRole
    keyVaultSecretsOfficerRole
    keyVaultSecretsUserRole
    postgresConnectionStringSecret
  ]
}

resource alpaEngineContainerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: alpaEngineContainerAppName
  location: location
  tags: union(commonTags, {
    'azd-service-name': 'alpa-engine'
  })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${userAssignedIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    configuration: {
      registries: [
        {
          server: '${containerRegistry.name}.azurecr.io'
          identity: userAssignedIdentity.id
        }
      ]
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        corsPolicy: {
          allowedOrigins: [
            '*'
          ]
          allowedMethods: [
            'GET'
            'POST'
            'PUT'
            'PATCH'
            'DELETE'
            'OPTIONS'
          ]
          allowedHeaders: [
            '*'
          ]
          exposeHeaders: [
            '*'
          ]
          maxAge: 86400
        }
      }
      secrets: alpaEngineSecretDefinitions
    }
    template: {
      containers: [
        {
          name: 'alpa-engine'
          image: alpaEngineImageRef
          env: alpaEngineEnv
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/health'
                port: 8080
              }
              initialDelaySeconds: 15
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/ready'
                port: 8080
              }
              initialDelaySeconds: 15
              periodSeconds: 30
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
        maxReplicas: 2
      }
    }
  }
  dependsOn: [
    acrPullRole
    keyVaultSecretsOfficerRole
    keyVaultSecretsUserRole
    postgresDatabase
    postgresFirewallRule
    postgresConnectionStringSecret
  ]
}

resource alpaCoreServiceContainerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: alpaCoreServiceContainerAppName
  location: location
  tags: union(commonTags, {
    'azd-service-name': 'alpacore-service'
  })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${userAssignedIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    configuration: {
      registries: [
        {
          server: '${containerRegistry.name}.azurecr.io'
          identity: userAssignedIdentity.id
        }
      ]
      ingress: {
        external: false
        targetPort: 8081
        transport: 'auto'
        corsPolicy: {
          allowedOrigins: [
            '*'
          ]
          allowedMethods: [
            'GET'
            'POST'
            'PUT'
            'PATCH'
            'DELETE'
            'OPTIONS'
          ]
          allowedHeaders: [
            '*'
          ]
          exposeHeaders: [
            '*'
          ]
          maxAge: 86400
        }
      }
      secrets: [
        {
          name: 'postgres-admin-password'
          value: postgresAdminPassword
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'alpacore-service'
          image: alpaCoreServiceImageRef
          env: [
            {
              name: 'PORT'
              value: '8081'
            }
            {
              name: 'DATABASE_HOST'
              value: postgresServer.properties.fullyQualifiedDomainName
            }
            {
              name: 'DATABASE_PORT'
              value: '5432'
            }
            {
              name: 'DATABASE_NAME'
              value: postgresDatabaseName
            }
            {
              name: 'DATABASE_USER'
              value: postgresAdminLogin
            }
            {
              name: 'DATABASE_PASSWORD'
              secretRef: 'postgres-admin-password'
            }
            {
              name: 'OLLAMA_HOST'
              value: externalOllamaUrl
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8081
              }
              initialDelaySeconds: 15
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: 8081
              }
              initialDelaySeconds: 15
              periodSeconds: 30
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 2
      }
    }
  }
  dependsOn: [
    acrPullRole
    keyVaultSecretsOfficerRole
    keyVaultSecretsUserRole
    postgresDatabase
    postgresFirewallRule
    postgresConnectionStringSecret
  ]
}

resource openWebUiContainerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: openWebUiContainerAppName
  location: location
  tags: union(commonTags, {
    'azd-service-name': 'open-webui'
  })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${userAssignedIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    configuration: {
      registries: [
        {
          server: '${containerRegistry.name}.azurecr.io'
          identity: userAssignedIdentity.id
        }
      ]
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        corsPolicy: {
          allowedOrigins: [
            '*'
          ]
          allowedMethods: [
            'GET'
            'POST'
            'PUT'
            'PATCH'
            'DELETE'
            'OPTIONS'
          ]
          allowedHeaders: [
            '*'
          ]
          exposeHeaders: [
            '*'
          ]
          maxAge: 86400
        }
      }
      secrets: openWebUiSecretDefinitions
    }
    template: {
      containers: [
        {
          name: 'open-webui'
          image: openWebUiImageRef
          env: openWebUiEnv
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8080
              }
              initialDelaySeconds: 20
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: 8080
              }
              initialDelaySeconds: 20
              periodSeconds: 30
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
        maxReplicas: 2
      }
    }
  }
  dependsOn: [
    acrPullRole
    keyVaultSecretsOfficerRole
    keyVaultSecretsUserRole
    webUiSecretKeySecret
    openAiApiKeySecret
  ]
}

output AZURE_CONTAINER_REGISTRY_ENDPOINT string = containerRegistry.properties.loginServer
output AZURE_KEY_VAULT_NAME string = keyVault.name
output AZURE_POSTGRES_SERVER_NAME string = postgresServer.name
output AZURE_POSTGRES_FQDN string = postgresServer.properties.fullyQualifiedDomainName
output SERVICE_OPENCLAW_RESOURCE_NAME string = openClawContainerApp.name
output SERVICE_ALPA_ENGINE_RESOURCE_NAME string = alpaEngineContainerApp.name
output SERVICE_ALPACORE_SERVICE_RESOURCE_NAME string = alpaCoreServiceContainerApp.name
output SERVICE_OPEN_WEBUI_RESOURCE_NAME string = openWebUiContainerApp.name
output SERVICE_ALPA_ENGINE_ENDPOINT_URL string = 'https://${alpaEngineContainerApp.properties.configuration.ingress.fqdn}'
output SERVICE_OPEN_WEBUI_ENDPOINT_URL string = 'https://${openWebUiContainerApp.properties.configuration.ingress.fqdn}'
