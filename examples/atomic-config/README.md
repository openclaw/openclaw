# Atomic Configuration Management Examples

This directory contains practical examples of using OpenClaw's atomic configuration management system.

## Basic Usage Examples

### 1. Safe Configuration Updates

```bash
# Create a backup before making changes
openclaw config backup --notes "Before enabling Discord integration"

# Apply new configuration atomically
openclaw config apply ./config-with-discord.json --notes "Enable Discord bot"

# If something goes wrong, rollback is automatic or manual:
openclaw config backups  # List available backups
openclaw config rollback 2026-02-11T22-45-30-123Z-abc12345
```

### 2. Configuration Patching

```bash
# Apply a partial configuration change
openclaw config patch ./api-key-update.json --notes "Rotate API keys"
```

**api-key-update.json:**
```json
{
  "models": {
    "providers": {
      "openai": {
        "apiKey": "${OPENAI_API_KEY_NEW}"
      },
      "anthropic": {
        "apiKey": "${ANTHROPIC_API_KEY_NEW}"
      }
    }
  }
}
```

### 3. Safe Mode Recovery

```bash
# If OpenClaw won't start due to config issues
openclaw config safe-mode enable --reason "Config debugging"
# Restart OpenClaw

# OpenClaw starts in minimal safe mode
# Fix the configuration
openclaw config validate --12-factor  # Check for issues
openclaw config apply ./fixed-config.json

# Exit safe mode
openclaw config safe-mode disable
# Restart OpenClaw normally
```

### 4. Emergency Recovery

```bash
# When configuration is completely broken
openclaw config emergency-recover

# This will:
# 1. Find the last known healthy backup
# 2. Restore it atomically
# 3. Verify it works via health check
# 4. Report success or suggest safe mode
```

## 12-Factor App Examples

### ❌ Before: Non-12-Factor Configuration

```json
{
  "environment": "production",
  "debug": false,
  "models": {
    "providers": {
      "openai": {
        "apiKey": "sk-hardcodedkey123456789",
        "baseUrl": "https://api.openai.com/v1"
      }
    }
  },
  "channels": {
    "discord": {
      "enabled": true,
      "token": "Bot MTIzNDU2Nzg5.hardcoded.token"
    }
  },
  "logging": {
    "level": "info",
    "file": "/var/log/openclaw.log"
  },
  "database": {
    "url": "postgresql://prod.amazonaws.com:5432/openclaw"
  }
}
```

**Issues detected by validation:**
- Hardcoded API keys (Factor 3: Config)
- Hardcoded service URLs (Factor 4: Backing Services)
- Environment-specific values (Factor 5: Build, Release, Run)
- File logging instead of stdout (Factor 11: Logs)

### ✅ After: 12-Factor Compliant Configuration

```json
{
  "models": {
    "providers": {
      "openai": {
        "apiKey": "${OPENAI_API_KEY}",
        "baseUrl": "${OPENAI_BASE_URL:-https://api.openai.com/v1}"
      }
    }
  },
  "channels": {
    "discord": {
      "enabled": "${DISCORD_ENABLED:-false}",
      "token": "${DISCORD_BOT_TOKEN}"
    }
  },
  "logging": {
    "level": "${LOG_LEVEL:-info}",
    "colorize": "${LOG_COLORIZE:-true}"
  },
  "database": {
    "url": "${DATABASE_URL}"
  }
}
```

**Environment variables (.env file):**
```env
# API Keys (Factor 3: Config)
OPENAI_API_KEY=sk-your-actual-key
DISCORD_BOT_TOKEN=Bot MTIzNDU2Nzg5.your.token

# Service URLs (Factor 4: Backing Services)
DATABASE_URL=postgresql://localhost:5432/openclaw-dev
OPENAI_BASE_URL=https://api.openai.com/v1

# Feature Flags (Factor 5: Build, Release, Run)
DISCORD_ENABLED=true
LOG_LEVEL=debug
LOG_COLORIZE=true
```

## Safe Mode Configuration Examples

### Minimal Safe Mode

```bash
openclaw config safe-mode generate > minimal-safe.json
```

**Generated minimal-safe.json:**
```json
{
  "meta": {
    "version": "1.0.0",
    "lastTouchedAt": "2026-02-11T22:45:30.123Z",
    "lastTouchedVersion": "safe-mode",
    "notes": "Generated safe mode configuration for recovery"
  },
  "gateway": {
    "host": "127.0.0.1",
    "port": 0,
    "auth": {
      "mode": "token",
      "token": "auto-generated-secure-token",
      "allowedOrigins": ["http://localhost", "https://localhost"]
    },
    "cors": { "enabled": false },
    "remote": { "enabled": false }
  },
  "agents": {
    "defaults": {
      "model": "gpt-3.5-turbo",
      "maxTokens": 500,
      "temperature": 0.1,
      "thinking": "off"
    },
    "list": [
      {
        "id": "recovery",
        "name": "Recovery Assistant",
        "systemPrompt": "You are a recovery assistant. Help fix OpenClaw configuration issues. Be concise and focus on essential operations only.",
        "capabilities": ["read", "write"]
      }
    ]
  },
  "tools": {
    "allowlist": ["read", "write", "exec", "config.*"],
    "security": "allowlist",
    "exec": {
      "security": "allowlist",
      "allowlist": ["ls", "cat", "pwd", "echo", "ps", "openclaw"],
      "timeout": 10000
    }
  },
  "channels": {},
  "plugins": { "enabled": false },
  "cron": { "enabled": false },
  "browser": { "enabled": false },
  "ui": { "safeMode": true }
}
```

### Safe Mode with Limited Channels

```bash
openclaw config safe-mode generate --enable-channels > safe-with-web.json
```

This enables local web interface for recovery operations.

## Programmatic Usage Examples

### TypeScript/JavaScript

```typescript
import { 
  getAtomicConfigManager, 
  applyConfigAtomic,
  createSafeModeConfig,
  determineStartupConfig 
} from '@openclaw/config';

// Apply configuration with custom validation
const manager = getAtomicConfigManager({
  maxBackups: 20,
  enableHealthCheck: true,
  healthCheckTimeoutMs: 45000,
  customValidation: async (config) => {
    // Custom validation logic
    if (!config.models?.providers?.openai?.apiKey) {
      return { valid: false, errors: ["OpenAI API key required"] };
    }
    return { valid: true, errors: [] };
  }
});

const result = await manager.applyConfigAtomic(newConfig, "Deploy v2.1.0");

if (result.success) {
  console.log(`✓ Configuration applied successfully`);
  console.log(`  Backup ID: ${result.backupId}`);
  console.log(`  Health check: ${result.healthCheckPassed ? 'PASSED' : 'SKIPPED'}`);
} else {
  console.error(`✗ Configuration apply failed: ${result.error}`);
  if (result.rolledBack) {
    console.log(`  → Automatically rolled back to backup: ${result.backupId}`);
  }
}

// Startup safety integration
const startupResult = await determineStartupConfig();

if (startupResult.useSafeMode) {
  console.log(`🔒 Starting in safe mode: ${startupResult.reason}`);
  logSafeModeActivation();
}

return startupResult.config;
```

### Gateway API Integration

```typescript
// Frontend configuration management
class ConfigManager {
  async applyConfigChanges(configUpdates: Partial<OpenClawConfig>) {
    try {
      // Get current config hash for optimistic concurrency
      const current = await this.gateway.request('config.get');
      
      // Apply changes atomically
      const result = await this.gateway.request('config.patch.atomic', {
        raw: JSON.stringify(configUpdates),
        baseHash: current.hash,
        enableHealthCheck: true,
        notes: `UI update: ${new Date().toISOString()}`
      });
      
      if (result.ok) {
        this.showSuccess(`Configuration updated successfully. Backup: ${result.backupId}`);
        return result;
      }
    } catch (error) {
      if (error.code === 'INVALID_REQUEST' && error.message.includes('config changed')) {
        this.showError('Configuration was modified by another process. Please refresh and try again.');
      } else {
        this.showError(`Configuration update failed: ${error.message}`);
      }
      throw error;
    }
  }
  
  async emergencyRecover() {
    const result = await this.gateway.request('config.emergency.recover');
    
    if (result.ok) {
      this.showSuccess(`Emergency recovery completed. Restored backup: ${result.backupId}`);
    } else {
      this.showError('Emergency recovery failed. Consider safe mode.');
      throw new Error(result.error);
    }
  }
}
```

## CI/CD Integration Examples

### GitHub Actions Workflow

```yaml
name: Deploy Configuration
on:
  push:
    paths: ['config/production.json']
    branches: ['main']

jobs:
  deploy-config:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Validate Configuration  
        run: |
          # Install OpenClaw CLI
          npm install -g @openclaw/cli
          
          # Validate against 12-factor principles
          openclaw config validate --12-factor config/production.json
          
      - name: Deploy to Production
        env:
          OPENCLAW_GATEWAY_TOKEN: ${{ secrets.OPENCLAW_GATEWAY_TOKEN }}
          OPENCLAW_GATEWAY_URL: ${{ secrets.OPENCLAW_GATEWAY_URL }}
        run: |
          # Create backup
          openclaw config backup --notes "Pre-deployment backup $(date)"
          
          # Apply configuration atomically
          openclaw config apply config/production.json \
            --notes "Deploy commit ${{ github.sha }}" \
            --timeout 60000
            
      - name: Rollback on Failure
        if: failure()
        run: |
          echo "Deployment failed, checking for automatic rollback..."
          openclaw config backups | head -1  # Should show rollback if it occurred
```

### Docker Healthcheck

```dockerfile
FROM node:18-alpine
COPY . /app
WORKDIR /app

# Install OpenClaw
RUN npm install -g @openclaw/cli

# Health check using atomic config system
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD openclaw config health-check --timeout 5000 || exit 1

CMD ["openclaw", "gateway", "start"]
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: openclaw
spec:
  replicas: 1
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0  # Ensure zero downtime
  template:
    spec:
      containers:
      - name: openclaw
        image: openclaw:latest
        env:
        - name: OPENCLAW_AUTO_RECOVER
          value: "true"
        - name: OPENCLAW_MAX_STARTUP_FAILURES  
          value: "2"
        readinessProbe:
          exec:
            command: ["openclaw", "config", "health-check", "--timeout", "10000"]
          initialDelaySeconds: 30
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 60
          periodSeconds: 30
      initContainers:
      - name: config-validator
        image: openclaw:latest
        command: ["openclaw", "config", "validate", "--12-factor"]
        env:
        - name: OPENCLAW_CONFIG_PATH
          value: "/config/openclaw.json"
```

## Monitoring and Alerting

### Prometheus Metrics

```yaml
# openclaw-config-metrics.yml
groups:
- name: openclaw-config
  rules:
  - alert: ConfigValidationFailure
    expr: openclaw_config_validation_failures_total > 0
    labels:
      severity: warning
    annotations:
      summary: "OpenClaw configuration validation failed"
      
  - alert: ConfigRollbackOccurred  
    expr: increase(openclaw_config_rollbacks_total[5m]) > 0
    labels:
      severity: critical
    annotations:
      summary: "OpenClaw configuration was rolled back"
      
  - alert: SafeModeActivated
    expr: openclaw_safe_mode_active == 1
    labels:
      severity: critical
    annotations:
      summary: "OpenClaw is running in safe mode"
```

### Log Analysis

```bash
# Monitor configuration changes
tail -f /var/log/openclaw.log | grep "config.*backup\|config.*apply\|safe.mode"

# Check for rollback events
grep -i "rollback\|emergency.recover" /var/log/openclaw.log | tail -10

# Monitor validation failures
grep -i "validation.*failed\|12.factor.*issue" /var/log/openclaw.log
```

## Best Practices Summary

1. **Always validate** configurations before applying: `openclaw config validate --12-factor`
2. **Use atomic operations** for all production changes: `config apply/patch`
3. **Include meaningful notes** in backups for audit trails
4. **Test rollback procedures** regularly in staging
5. **Monitor health checks** and be prepared for auto-rollback
6. **Use safe mode** for emergency recovery scenarios
7. **Follow 12-factor principles** for cloud-native deployments
8. **Automate validation** in CI/CD pipelines
9. **Keep backups secure** and test restoration procedures
10. **Document recovery procedures** for your team