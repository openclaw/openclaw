# Example Configurations

Production-ready configuration examples for different deployment scenarios.

## Contents

- [Development](#development) - Local development setup
- [Staging](#staging) - Pre-production testing
- [Production Small](#production-small) - Small-scale production (< 100 users)
- [Production Large](#production-large) - Large-scale production (> 1000 users)
- [Enterprise](#enterprise) - Enterprise with compliance requirements

---

## Development

**File:** `development.json5`

```json5
{
  // Gateway configuration
  "gateway": {
    "port": 18789,
    "bind": "127.0.0.1",
    "auth": {
      "mode": "token",
      "token": "dev-token-1234567890"
    },
    "diagnostics": {
      "enabled": true,
      "timeline": true,
      "payloadLarge": true
    },
    "talk": {
      "provider": "openai",
      "realtime": {
        "mode": "realtime",
        "transport": "webrtc",
        "brain": "agent-consult"
      }
    }
  },

  // Model providers
  "models": {
    "providers": {
      "anthropic": {
        "apiKey": { "source": "env", "id": "ANTHROPIC_API_KEY" },
        "models": ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-3-5"]
      },
      "openai": {
        "apiKey": { "source": "env", "id": "OPENAI_API_KEY" },
        "models": ["gpt-5.5", "gpt-5.4-mini", "gpt-realtime-2.1"]
      },
      "google": {
        "apiKey": { "source": "env", "id": "GEMINI_API_KEY" },
        "models": ["gemini-3.1-pro-preview", "gemini-3-flash-preview"]
      }
    },
    "routing": {
      "triage": "google/gemini-3-flash-preview",
      "reasoning": "anthropic/claude-opus-4-7",
      "coding": "anthropic/claude-opus-4-7",
      "embedding": "google/gemini-3-flash-preview"
    }
  },

  // Agent configuration
  "agents": {
    "defaults": {
      "workspace": "~/.openclaw/workspace",
      "bootstrapMaxChars": 20000,
      "bootstrapTotalMaxChars": 60000,
      "sandbox": false, // Disable for development
      "memorySearch": {
        "provider": "local",
        "hybrid": {
          "vectorWeight": 0.7,
          "textWeight": 0.3,
          "mmrDiversification": true,
          "temporalDecayHalflife": "30d"
        }
      }
    }
  },

  // Memory backend
  "memory": {
    "backend": "builtin"
  },

  // Tools
  "tools": {
    "profile": "default",
    "exec": {
      "security": "development", // Relaxed for development
      "ask": "never"
    }
  },

  // Channels
  "channels": {
    "telegram": {
      "enabled": false, // Enable when testing
      "botToken": { "source": "env", "id": "TELEGRAM_BOT_TOKEN" }
    },
    "discord": {
      "enabled": false,
      "botToken": { "source": "env", "id": "DISCORD_BOT_TOKEN" }
    }
  },

  // Monitoring
  "monitoring": {
    "enabled": true,
    "metrics": true,
    "prometheus": {
      "port": 9090
    }
  },

  // Logging
  "logging": {
    "level": "debug", // Verbose for development
    "format": "pretty"
  }
}
```

---

## Staging

**File:** `staging.json5`

```json5
{
  "gateway": {
    "port": 18789,
    "bind": "0.0.0.0",
    "auth": {
      "mode": "token",
      "token": { "source": "env", "id": "OPENCLAW_GATEWAY_TOKEN" }
    },
    "tls": {
      "enabled": true,
      "cert": "/etc/ssl/certs/mythos-staging.crt",
      "key": "/etc/ssl/private/mythos-staging.key"
    },
    "diagnostics": {
      "enabled": true,
      "timeline": true
    },
    "talk": {
      "provider": "openai",
      "realtime": {
        "mode": "realtime",
        "transport": "webrtc",
        "brain": "agent-consult"
      }
    }
  },

  "models": {
    "providers": {
      "anthropic": {
        "apiKey": { "source": "env", "id": "ANTHROPIC_API_KEY" },
        "models": ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-3-5"]
      },
      "openai": {
        "apiKey": { "source": "env", "id": "OPENAI_API_KEY" },
        "models": ["gpt-5.5", "gpt-5.4-mini"]
      },
      "google": {
        "apiKey": { "source": "env", "id": "GEMINI_API_KEY" },
        "models": ["gemini-3.1-pro-preview", "gemini-3-flash-preview"]
      }
    },
    "routing": {
      "triage": "google/gemini-3-flash-preview",
      "reasoning": "anthropic/claude-opus-4-7",
      "coding": "anthropic/claude-opus-4-7"
    }
  },

  "agents": {
    "defaults": {
      "workspace": "/home/openclaw/.openclaw/workspace",
      "bootstrapMaxChars": 20000,
      "bootstrapTotalMaxChars": 60000,
      "sandbox": true,
      "workspaceAccess": "rw",
      "memorySearch": {
        "provider": "local",
        "hybrid": {
          "vectorWeight": 0.7,
          "textWeight": 0.3,
          "mmrDiversification": true,
          "temporalDecayHalflife": "30d"
        }
      }
    }
  },

  "memory": {
    "backend": "builtin"
  },

  "tools": {
    "profile": "default",
    "exec": {
      "security": "default",
      "ask": "risky"
    }
  },

  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": { "source": "env", "id": "TELEGRAM_BOT_TOKEN" },
      "allowFrom": ["staging-user-id-1", "staging-user-id-2"]
    },
    "discord": {
      "enabled": true,
      "botToken": { "source": "env", "id": "DISCORD_BOT_TOKEN" },
      "guildId": "staging-guild-id"
    }
  },

  "monitoring": {
    "enabled": true,
    "metrics": true,
    "prometheus": {
      "port": 9090,
      "path": "/metrics"
    }
  },

  "logging": {
    "level": "info",
    "format": "json",
    "output": "file",
    "file": "/var/log/mythos/mythos.log"
  },

  "backup": {
    "enabled": true,
    "schedule": "0 2 * * *",
    "retention": "7d",
    "destination": "/var/backups/mythos"
  }
}
```

---

## Production Small

**File:** `production-small.json5`

```json5
{
  "gateway": {
    "port": 18789,
    "bind": "0.0.0.0",
    "auth": {
      "mode": "token",
      "token": { "source": "env", "id": "OPENCLAW_GATEWAY_TOKEN" }
    },
    "tls": {
      "enabled": true,
      "cert": "/etc/ssl/certs/mythos.crt",
      "key": "/etc/ssl/private/mythos.key",
      "minVersion": "TLSv1.3"
    },
    "diagnostics": {
      "enabled": false // Disabled for production
    },
    "rateLimit": {
      "enabled": true,
      "windowMs": 60000,
      "maxRequests": 100
    }
  },

  "models": {
    "providers": {
      "anthropic": {
        "apiKey": { "source": "env", "id": "ANTHROPIC_API_KEY" },
        "models": ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-3-5"]
      },
      "openai": {
        "apiKey": { "source": "env", "id": "OPENAI_API_KEY" },
        "models": ["gpt-5.5", "gpt-5.4-mini"]
      },
      "google": {
        "apiKey": { "source": "env", "id": "GEMINI_API_KEY" },
        "models": ["gemini-3.1-pro-preview", "gemini-3-flash-preview"]
      }
    },
    "routing": {
      "triage": "google/gemini-3-flash-preview",
      "reasoning": "anthropic/claude-opus-4-7",
      "coding": "anthropic/claude-opus-4-7"
    },
    "budget": {
      "tokensPerHour": 100000,
      "costPerHour": "$5.00"
    }
  },

  "agents": {
    "defaults": {
      "workspace": "/home/openclaw/.openclaw/workspace",
      "bootstrapMaxChars": 20000,
      "bootstrapTotalMaxChars": 60000,
      "sandbox": true,
      "workspaceAccess": "rw",
      "maxConcurrent": 5,
      "subagentMaxConcurrent": 10,
      "timeout": 300000,
      "memorySearch": {
        "provider": "local",
        "hybrid": {
          "vectorWeight": 0.7,
          "textWeight": 0.3,
          "mmrDiversification": true,
          "temporalDecayHalflife": "30d"
        }
      }
    }
  },

  "memory": {
    "backend": "builtin"
  },

  "tools": {
    "profile": "production",
    "exec": {
      "security": "strict",
      "ask": "always"
    }
  },

  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": { "source": "env", "id": "TELEGRAM_BOT_TOKEN" },
      "allowFrom": ["user-id-1", "user-id-2", "user-id-3"]
    },
    "discord": {
      "enabled": true,
      "botToken": { "source": "env", "id": "DISCORD_BOT_TOKEN" },
      "guildId": "guild-id"
    },
    "slack": {
      "enabled": true,
      "botToken": { "source": "env", "id": "SLACK_BOT_TOKEN" },
      "appToken": { "source": "env", "id": "SLACK_APP_TOKEN" }
    }
  },

  "monitoring": {
    "enabled": true,
    "metrics": true,
    "prometheus": {
      "port": 9090,
      "path": "/metrics"
    },
    "alerts": {
      "enabled": true,
      "slack": {
        "webhook": { "source": "env", "id": "SLACK_ALERT_WEBHOOK" }
      }
    }
  },

  "logging": {
    "level": "info",
    "format": "json",
    "output": "file",
    "file": "/var/log/mythos/mythos.log",
    "rotation": {
      "maxSize": "100MB",
      "maxFiles": 10
    }
  },

  "backup": {
    "enabled": true,
    "schedule": "0 2 * * *",
    "retention": "30d",
    "destination": "/var/backups/mythos",
    "encryption": {
      "enabled": true,
      "key": { "source": "env", "id": "BACKUP_ENCRYPTION_KEY" }
    }
  },

  "security": {
    "networkPolicy": {
      "enabled": true,
      "allowedHosts": [
        "api.anthropic.com",
        "api.openai.com",
        "generativelanguage.googleapis.com"
      ]
    },
    "audit": {
      "enabled": true,
      "events": [
        "authentication",
        "authorization",
        "data_access",
        "configuration_change"
      ]
    }
  }
}
```

---

## Production Large

**File:** `production-large.json5`

```json5
{
  "gateway": {
    "port": 18789,
    "bind": "0.0.0.0",
    "auth": {
      "mode": "token",
      "token": { "source": "env", "id": "OPENCLAW_GATEWAY_TOKEN" }
    },
    "tls": {
      "enabled": true,
      "cert": "/etc/ssl/certs/mythos.crt",
      "key": "/etc/ssl/private/mythos.key",
      "minVersion": "TLSv1.3"
    },
    "rateLimit": {
      "enabled": true,
      "windowMs": 60000,
      "maxRequests": 500,
      "byIp": true,
      "byUser": true
    }
  },

  "models": {
    "providers": {
      "anthropic": {
        "apiKey": { "source": "env", "id": "ANTHROPIC_API_KEY" },
        "models": ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-3-5"],
        "rateLimit": {
          "requestsPerMinute": 1000
        }
      },
      "openai": {
        "apiKey": { "source": "env", "id": "OPENAI_API_KEY" },
        "models": ["gpt-5.5", "gpt-5.4-mini"],
        "rateLimit": {
          "requestsPerMinute": 1000
        }
      },
      "google": {
        "apiKey": { "source": "env", "id": "GEMINI_API_KEY" },
        "models": ["gemini-3.1-pro-preview", "gemini-3-flash-preview"],
        "rateLimit": {
          "requestsPerMinute": 1000
        }
      },
      "local": {
        "baseUrl": "http://localhost:11434/v1",
        "models": ["nemotron-70b", "llama-3.3-70b"]
      }
    },
    "routing": {
      "triage": "google/gemini-3-flash-preview",
      "reasoning": "anthropic/claude-opus-4-7",
      "coding": "anthropic/claude-opus-4-7",
      "sensitive": "local/nemotron-70b"
    },
    "budget": {
      "tokensPerHour": 500000,
      "costPerHour": "$20.00"
    }
  },

  "agents": {
    "defaults": {
      "workspace": "/home/openclaw/.openclaw/workspace",
      "bootstrapMaxChars": 20000,
      "bootstrapTotalMaxChars": 60000,
      "sandbox": true,
      "workspaceAccess": "rw",
      "maxConcurrent": 20,
      "subagentMaxConcurrent": 50,
      "timeout": 600000,
      "memorySearch": {
        "provider": "local",
        "hybrid": {
          "vectorWeight": 0.7,
          "textWeight": 0.3,
          "mmrDiversification": true,
          "temporalDecayHalflife": "30d"
        }
      }
    }
  },

  "memory": {
    "backend": "builtin",
    "vector": {
      "maxElements": 10000000,
      "efConstruction": 200,
      "m": 16
    },
    "text": {
      "writerBuffer": 100000000
    }
  },

  "tools": {
    "profile": "production",
    "exec": {
      "security": "strict",
      "ask": "always",
      "timeout": 60000
    }
  },

  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": { "source": "env", "id": "TELEGRAM_BOT_TOKEN" },
      "allowFrom": "env:ALLOWED_TELEGRAM_USERS"
    },
    "discord": {
      "enabled": true,
      "botToken": { "source": "env", "id": "DISCORD_BOT_TOKEN" },
      "guildId": { "source": "env", "id": "DISCORD_GUILD_ID" }
    },
    "slack": {
      "enabled": true,
      "botToken": { "source": "env", "id": "SLACK_BOT_TOKEN" },
      "appToken": { "source": "env", "id": "SLACK_APP_TOKEN" }
    },
    "whatsapp": {
      "enabled": true,
      "allowFrom": "env:ALLOWED_WHATSAPP_USERS"
    }
  },

  "monitoring": {
    "enabled": true,
    "metrics": true,
    "prometheus": {
      "port": 9090,
      "path": "/metrics"
    },
    "alerts": {
      "enabled": true,
      "slack": {
        "webhook": { "source": "env", "id": "SLACK_ALERT_WEBHOOK" }
      },
      "pagerduty": {
        "key": { "source": "env", "id": "PAGERDUTY_KEY" }
      }
    }
  },

  "logging": {
    "level": "info",
    "format": "json",
    "output": "file",
    "file": "/var/log/mythos/mythos.log",
    "rotation": {
      "maxSize": "500MB",
      "maxFiles": 20
    }
  },

  "backup": {
    "enabled": true,
    "schedule": "0 */6 * * *", // Every 6 hours
    "retention": "90d",
    "destination": "/var/backups/mythos",
    "encryption": {
      "enabled": true,
      "key": { "source": "env", "id": "BACKUP_ENCRYPTION_KEY" }
    },
    "offsite": {
      "enabled": true,
      "provider": "s3",
      "bucket": "mythos-backups",
      "region": "us-west-2"
    }
  },

  "security": {
    "networkPolicy": {
      "enabled": true,
      "allowedHosts": [
        "api.anthropic.com",
        "api.openai.com",
        "generativelanguage.googleapis.com",
        "api.telegram.org",
        "discord.com",
        "slack.com"
      ]
    },
    "audit": {
      "enabled": true,
      "events": [
        "authentication",
        "authorization",
        "data_access",
        "configuration_change",
        "agent_action",
        "tool_execution"
      ]
    },
    "encryption": {
      "atRest": true,
      "inTransit": true
    }
  },

  "scaling": {
    "horizontalPodAutoscaler": {
      "enabled": true,
      "minReplicas": 3,
      "maxReplicas": 20,
      "targetCPUUtilization": 70,
      "targetMemoryUtilization": 80
    }
  }
}
```

---

## Enterprise

**File:** `enterprise.json5`

```json5
{
  "gateway": {
    "port": 18789,
    "bind": "0.0.0.0",
    "auth": {
      "mode": "oauth2",
      "oauth2": {
        "provider": "okta",
        "clientId": { "source": "env", "id": "OKTA_CLIENT_ID" },
        "clientSecret": { "source": "env", "id": "OKTA_CLIENT_SECRET" },
        "issuer": "https://company.okta.com"
      }
    },
    "tls": {
      "enabled": true,
      "cert": "/etc/ssl/certs/mythos.crt",
      "key": "/etc/ssl/private/mythos.key",
      "minVersion": "TLSv1.3",
      "cipherSuites": [
        "TLS_AES_256_GCM_SHA384",
        "TLS_CHACHA20_POLY1305_SHA256"
      ]
    },
    "rateLimit": {
      "enabled": true,
      "windowMs": 60000,
      "maxRequests": 1000,
      "byIp": true,
      "byUser": true,
      "byApiKey": true
    }
  },

  "models": {
    "providers": {
      "anthropic": {
        "apiKey": { "source": "vault", "id": "secret/data/anthropic#api_key" },
        "models": ["claude-opus-4-7", "claude-sonnet-4-6"],
        "rateLimit": {
          "requestsPerMinute": 2000,
          "tokensPerMinute": 1000000
        }
      },
      "openai": {
        "apiKey": { "source": "vault", "id": "secret/data/openai#api_key" },
        "models": ["gpt-5.5"],
        "rateLimit": {
          "requestsPerMinute": 2000,
          "tokensPerMinute": 1000000
        }
      },
      "google": {
        "apiKey": { "source": "vault", "id": "secret/data/google#api_key" },
        "models": ["gemini-3.1-pro-preview"],
        "rateLimit": {
          "requestsPerMinute": 2000,
          "tokensPerMinute": 1000000
        }
      },
      "local": {
        "baseUrl": "http://nemotron-cluster:11434/v1",
        "models": ["nemotron-70b"],
        "loadBalancer": {
          "enabled": true,
          "strategy": "round-robin",
          "healthCheck": {
            "interval": 10000,
            "timeout": 5000
          }
        }
      }
    },
    "routing": {
      "triage": "google/gemini-3-flash-preview",
      "reasoning": "anthropic/claude-opus-4-7",
      "coding": "anthropic/claude-opus-4-7",
      "sensitive": "local/nemotron-70b",
      "pii": "local/nemotron-70b"
    },
    "budget": {
      "tokensPerHour": 2000000,
      "costPerHour": "$100.00",
      "alerts": {
        "threshold": 0.8,
        "notify": ["slack:enterprise-alerts", "email:ai-team@company.com"]
      }
    }
  },

  "agents": {
    "defaults": {
      "workspace": "/data/openclaw/workspace",
      "bootstrapMaxChars": 40000,
      "bootstrapTotalMaxChars": 120000,
      "sandbox": true,
      "workspaceAccess": "rw",
      "maxConcurrent": 50,
      "subagentMaxConcurrent": 200,
      "timeout": 1200000,
      "memorySearch": {
        "provider": "local",
        "hybrid": {
          "vectorWeight": 0.7,
          "textWeight": 0.3,
          "mmrDiversification": true,
          "temporalDecayHalflife": "30d"
        }
      },
      "rbac": {
        "enabled": true,
        "roles": {
          "admin": { "permissions": ["*"] },
          "operator": { "permissions": ["read", "write", "execute"] },
          "viewer": { "permissions": ["read"] },
          "agent": { "permissions": ["read", "execute"] }
        }
      }
    }
  },

  "memory": {
    "backend": "builtin",
    "vector": {
      "maxElements": 100000000,
      "efConstruction": 400,
      "m": 32
    },
    "text": {
      "writerBuffer": 500000000
    },
    "encryption": {
      "enabled": true,
      "algorithm": "AES-256-GCM"
    }
  },

  "tools": {
    "profile": "enterprise",
    "exec": {
      "security": "strict",
      "ask": "always",
      "timeout": 120000,
      "allowedCommands": [
        "git", "npm", "pnpm", "docker", "kubectl",
        "aws", "gcloud", "az"
      ],
      "deniedCommands": [
        "rm -rf", "sudo", "chmod 777"
      ]
    }
  },

  "channels": {
    "teams": {
      "enabled": true,
      "appId": { "source": "vault", "id": "secret/data/teams#app_id" },
      "appPassword": { "source": "vault", "id": "secret/data/teams#app_password" }
    },
    "slack": {
      "enabled": true,
      "botToken": { "source": "vault", "id": "secret/data/slack#bot_token" },
      "appToken": { "source": "vault", "id": "secret/data/slack#app_token" },
      "signingSecret": { "source": "vault", "id": "secret/data/slack#signing_secret" }
    }
  },

  "monitoring": {
    "enabled": true,
    "metrics": true,
    "prometheus": {
      "port": 9090,
      "path": "/metrics",
      "retention": "365d"
    },
    "alerts": {
      "enabled": true,
      "channels": [
        {
          "type": "slack",
          "webhook": { "source": "vault", "id": "secret/data/alerts#slack_webhook" }
        },
        {
          "type": "pagerduty",
          "key": { "source": "vault", "id": "secret/data/alerts#pagerduty_key" }
        },
        {
          "type": "email",
          "smtp": {
            "host": "smtp.company.com",
            "port": 587,
            "user": { "source": "vault", "id": "secret/data/alerts#smtp_user" },
            "password": { "source": "vault", "id": "secret/data/alerts#smtp_password" }
          },
          "recipients": ["ai-team@company.com", "security@company.com"]
        }
      ]
    },
    "tracing": {
      "enabled": true,
      "provider": "jaeger",
      "endpoint": "http://jaeger:14268/api/traces"
    }
  },

  "logging": {
    "level": "info",
    "format": "json",
    "output": "file",
    "file": "/var/log/mythos/mythos.log",
    "rotation": {
      "maxSize": "1GB",
      "maxFiles": 50
    },
    "shipper": {
      "enabled": true,
      "provider": "elasticsearch",
      "endpoint": "https://elasticsearch.company.com:9200",
      "index": "mythos-logs",
      "auth": {
        "user": { "source": "vault", "id": "secret/data/logging#es_user" },
        "password": { "source": "vault", "id": "secret/data/logging#es_password" }
      }
    }
  },

  "backup": {
    "enabled": true,
    "schedule": "0 */4 * * *", // Every 4 hours
    "retention": "365d",
    "destination": "/data/backups/mythos",
    "encryption": {
      "enabled": true,
      "algorithm": "AES-256-GCM",
      "key": { "source": "vault", "id": "secret/data/backup#encryption_key" }
    },
    "offsite": {
      "enabled": true,
      "providers": [
        {
          "type": "s3",
          "bucket": "mythos-backups-primary",
          "region": "us-west-2",
          "credentials": { "source": "vault", "id": "secret/data/aws#credentials" }
        },
        {
          "type": "s3",
          "bucket": "mythos-backups-dr",
          "region": "us-east-1",
          "credentials": { "source": "vault", "id": "secret/data/aws#credentials" }
        }
      ]
    },
    "testing": {
      "enabled": true,
      "schedule": "0 0 * * 0" // Weekly
    }
  },

  "security": {
    "networkPolicy": {
      "enabled": true,
      "allowedHosts": [
        "api.anthropic.com",
        "api.openai.com",
        "generativelanguage.googleapis.com",
        "*.slack.com",
        "*.teams.microsoft.com"
      ],
      "deniedHosts": [
        "*.internal.company.com",
        "metadata.google.internal"
      ]
    },
    "audit": {
      "enabled": true,
      "events": [
        "authentication",
        "authorization",
        "data_access",
        "configuration_change",
        "agent_action",
        "tool_execution",
        "security_violation"
      ],
      "retention": "2555d" // 7 years for compliance
    },
    "encryption": {
      "atRest": true,
      "inTransit": true,
      "keyManagement": {
        "provider": "vault",
        "rotation": "90d"
      }
    },
    "compliance": {
      "soc2": true,
      "hipaa": true,
      "gdpr": true,
      "pci": false
    }
  },

  "scaling": {
    "horizontalPodAutoscaler": {
      "enabled": true,
      "minReplicas": 5,
      "maxReplicas": 50,
      "targetCPUUtilization": 60,
      "targetMemoryUtilization": 70
    },
    "podDisruptionBudget": {
      "enabled": true,
      "minAvailable": 3
    }
  },

  "disasterRecovery": {
    "enabled": true,
    "rpo": "4h", // Recovery Point Objective
    "rto": "1h", // Recovery Time Objective
    "drSite": "us-east-1",
    "failover": {
      "enabled": true,
      "mode": "active-passive"
    }
  }
}
```

---

## Usage

### Apply Configuration

```bash
# Copy desired config
cp examples/configs/production-small.json5 ~/.openclaw/openclaw.json

# Validate configuration
jq empty ~/.openclaw/openclaw.json

# Restart gateway
docker restart mythos-gateway
```

### Environment Variables

Create `.env` file with required variables:

```bash
# Gateway token
OPENCLAW_GATEWAY_TOKEN=your-secure-token

# API keys
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AIza...

# Channel tokens
TELEGRAM_BOT_TOKEN=...
DISCORD_BOT_TOKEN=...
SLACK_BOT_TOKEN=...

# Database
PG_USER=mythos
PG_PASSWORD=your-secure-password
PG_DATABASE=mythos
```

### Validation

```bash
# Validate JSON syntax
jq empty openclaw.json

# Validate against schema
node scripts/validate-config.js openclaw.json

# Check security
node scripts/security-check.js openclaw.json
```

---

## Best Practices

1. **Never commit secrets**: Use environment variables or vault
2. **Rotate tokens regularly**: At least every 90 days
3. **Enable TLS in production**: Always use HTTPS
4. **Set resource limits**: Prevent resource exhaustion
5. **Enable monitoring**: Track performance and errors
6. **Configure backups**: Regular automated backups
7. **Test disaster recovery**: Regular DR drills
8. **Audit configurations**: Regular security reviews

---

## Support

- **Documentation:** https://docs.openclaw.ai
- **Issues:** https://github.com/openclaw/openclaw/issues
- **Discord:** https://discord.gg/openclaw

---

## License

MIT License - See LICENSE for details.
