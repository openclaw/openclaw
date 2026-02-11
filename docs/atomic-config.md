# Atomic Configuration Management

OpenClaw's atomic configuration management system provides safe, atomic operations for configuration changes with automatic validation, backup, rollback, and health checking.

## Overview

The atomic configuration management system addresses several critical concerns:

1. **Atomic Operations**: Configuration changes are applied atomically - either they succeed completely or fail with no partial state
2. **Automatic Backup**: Every configuration change automatically creates a backup of the previous working configuration  
3. **Validation**: Comprehensive validation including OpenClaw schema validation and 12-factor app principles
4. **Health Checking**: Post-apply health checks verify that OpenClaw can start successfully with the new configuration
5. **Auto-Rollback**: If health checks fail, the system automatically rolls back to the last known good configuration
6. **Safe Mode**: A minimal, recovery-focused configuration mode for when the main configuration is broken

## Key Features

### Atomic Config Operations

```bash
# Apply configuration atomically with full validation and health checking
openclaw config apply ./new-config.json --notes "Enable new features"

# Patch configuration with atomic guarantees  
openclaw config patch ./config-patch.json --notes "Update API keys"

# Emergency recovery using last known good configuration
openclaw config emergency-recover
```

### Backup Management

```bash
# Create manual backup
openclaw config backup --notes "Before major changes"

# List available backups
openclaw config backups

# Rollback to specific backup
openclaw config rollback 2026-02-11T22-45-30-123Z-abc12345
```

### Safe Mode

```bash
# Enable safe mode for next startup
openclaw config safe-mode enable --reason "Configuration debugging"

# Check safe mode status
openclaw config safe-mode status

# Generate safe mode configuration
openclaw config safe-mode generate --output safe-config.json

# Disable safe mode
openclaw config safe-mode disable
```

### Validation and Health Checks

```bash
# Validate current configuration
openclaw config validate --12-factor

# Perform health check
openclaw config health-check --timeout 30000
```

## Architecture

### Atomic Configuration Manager

The `AtomicConfigManager` class provides the core atomic operations:

```typescript
import { getAtomicConfigManager } from '@openclaw/config';

const manager = getAtomicConfigManager({
  maxBackups: 10,
  enableHealthCheck: true,
  healthCheckTimeoutMs: 30000,
});

// Apply configuration atomically
const result = await manager.applyConfigAtomic(newConfig, "Update notes");
if (result.success) {
  console.log(`Applied successfully, backup: ${result.backupId}`);
} else {
  console.error(`Apply failed: ${result.error}`);
  if (result.rolledBack) {
    console.log("Automatically rolled back to previous configuration");
  }
}
```

### Safe Mode

Safe mode provides a minimal, secure configuration for recovery scenarios:

```typescript
import { createSafeModeConfig, shouldStartInSafeMode } from '@openclaw/config';

// Check if safe mode should be activated
if (shouldStartInSafeMode()) {
  const safeConfig = createSafeModeConfig({
    enableChannels: false,
    enablePlugins: false,
    adminPassword: process.env.OPENCLAW_RECOVERY_PASSWORD,
  });
  
  // Use safe configuration for startup
  return safeConfig;
}
```

### Startup Safety

The startup safety system handles crash detection and recovery:

```typescript
import { determineStartupConfig } from '@openclaw/config';

// Determine configuration based on safety conditions
const startupResult = await determineStartupConfig({
  maxStartupFailures: 3,
  autoRecover: true,
});

if (startupResult.useSafeMode) {
  console.log(`Starting in safe mode: ${startupResult.reason}`);
} else if (startupResult.emergencyRecovered) {
  console.log(`Emergency recovery applied: ${startupResult.backupRestored}`);
}

// Use the determined configuration
return startupResult.config;
```

## Configuration Validation

### 12-Factor App Principles

The system validates configurations against 12-factor app principles:

1. **Config**: Detects hardcoded secrets that should be in environment variables
2. **Backing Services**: Identifies hardcoded service URLs
3. **Build, Release, Run**: Checks for environment-specific configuration
4. **Dev/Prod Parity**: Warns about development-only settings
5. **Logs**: Validates logging configuration for cloud-native deployments

### Example Validation Issues

```typescript
// ❌ Hardcoded secrets (detected)
{
  "providers": {
    "openai": {
      "apiKey": "sk-hardcodedkey123"  // Should use ${OPENAI_API_KEY}
    }
  }
}

// ❌ Environment-specific config (detected)
{
  "environment": "production",  // Should be externalized
  "debug": false
}

// ✅ Proper 12-factor config
{
  "providers": {
    "openai": {
      "apiKey": "${OPENAI_API_KEY}"
    }
  },
  "logging": {
    "level": "${LOG_LEVEL:-info}"
  }
}
```

## Gateway API Extensions

The atomic configuration system extends the gateway API with new endpoints:

### Atomic Apply/Patch

```typescript
// Apply configuration atomically
await gateway.request('config.apply.atomic', {
  raw: JSON.stringify(newConfig),
  baseHash: currentConfigHash,
  enableHealthCheck: true,
  healthCheckTimeoutMs: 30000,
  notes: "Enable new features"
});

// Patch configuration atomically  
await gateway.request('config.patch.atomic', {
  raw: JSON.stringify(configPatch),
  baseHash: currentConfigHash,
  notes: "Update settings"
});
```

### Backup Management

```typescript
// Create backup
const { backupId } = await gateway.request('config.backup.create', {
  notes: "Pre-deployment backup"
});

// List backups
const { backups } = await gateway.request('config.backup.list');

// Rollback
await gateway.request('config.backup.rollback', {
  backupId: "2026-02-11T22-45-30-123Z-abc12345"
});
```

### Safe Mode Management

```typescript
// Enable safe mode
await gateway.request('config.safemode.enable', {
  reason: "Configuration recovery"
});

// Check status
const { active } = await gateway.request('config.safemode.status');

// Generate safe config
const { config } = await gateway.request('config.safemode.generate', {
  options: { enableChannels: false }
});
```

## Environment Variables

### Safe Mode Control

- `OPENCLAW_SAFE_MODE=true` - Enable safe mode
- `OPENCLAW_SAFE_MODE_CHANNELS=true` - Enable channels in safe mode
- `OPENCLAW_SAFE_MODE_PLUGINS=true` - Enable plugins in safe mode
- `OPENCLAW_SAFE_MODE_PASSWORD=secret` - Admin password for safe mode
- `OPENCLAW_SAFE_MODE_PORT=3000` - Gateway port for safe mode

### Startup Safety Configuration

- `OPENCLAW_AUTO_RECOVER=true` - Enable automatic recovery
- `OPENCLAW_MAX_STARTUP_FAILURES=3` - Maximum failures before safe mode
- `OPENCLAW_FAILURE_WINDOW_MS=300000` - Time window for failure counting

## File System Layout

```
~/.openclaw/
├── config.json                    # Main configuration
├── config-backups/                # Atomic configuration backups
│   ├── 2026-02-11T22-45-30-123Z-abc12345.json
│   ├── 2026-02-11T22-45-30-123Z-abc12345.meta.json
│   └── ...
├── config-temp/                   # Temporary files for atomic operations
├── safe-mode.sentinel             # Safe mode activation sentinel
├── startup-failures.json          # Startup failure history
└── restart-sentinels/             # Restart coordination files
```

## Best Practices

### Configuration Changes

1. **Always use atomic operations** for production configuration changes
2. **Include meaningful notes** in backups for change tracking
3. **Test configurations** in staging before production
4. **Monitor health checks** and be prepared for auto-rollback

### Safe Mode

1. **Use safe mode for recovery** when normal configuration is broken
2. **Keep safe mode minimal** - disable unnecessary features
3. **Secure safe mode access** with strong passwords and IP restrictions
4. **Document safe mode procedures** for your team

### Backup Management

1. **Regular backups** before major changes
2. **Clean up old backups** periodically (automatic with configurable limits)
3. **Test rollback procedures** regularly
4. **Store critical backups externally** for disaster recovery

### 12-Factor Compliance

1. **Externalize all secrets** to environment variables
2. **Use environment variables** for service URLs and configuration
3. **Avoid environment-specific values** in configuration files
4. **Log to stdout/stderr** in cloud environments
5. **Keep development and production parity**

## Troubleshooting

### Configuration Validation Failures

```bash
# Check detailed validation results
openclaw config validate --12-factor --json

# Common issues:
# - Hardcoded API keys → Use ${ENV_VAR} syntax
# - Development settings in production → Remove or externalize
# - File logging → Use stdout/stderr logging
```

### Health Check Failures

```bash
# Manual health check with extended timeout
openclaw config health-check --timeout 60000

# Common causes:
# - Invalid plugin configurations
# - Network connectivity issues
# - Resource constraints
# - Permission problems
```

### Safe Mode Issues

```bash
# Check safe mode status and configuration
openclaw config safe-mode status
openclaw config safe-mode generate | jq

# If safe mode config is invalid:
openclaw config safe-mode generate --enable-channels > safe.json
openclaw config validate < safe.json
```

### Emergency Recovery

```bash
# When all else fails
openclaw config emergency-recover

# If no healthy backups exist:
openclaw config safe-mode enable --reason "Manual recovery needed"
# Restart OpenClaw
# Fix configuration in safe mode
# openclaw config safe-mode disable
```

## Migration from Legacy Config System

The atomic configuration system is fully backward compatible. Existing configurations will continue to work, but you can opt into atomic operations:

```bash
# Migrate to atomic operations gradually
openclaw config backup --notes "Pre-atomic migration"
openclaw config apply current-config.json --notes "Migrate to atomic"
```

Legacy `config.apply` and `config.patch` endpoints remain available, but `config.apply.atomic` and `config.patch.atomic` are recommended for new implementations.

## Implementation Details

### Atomic Write Pattern

1. **Validation**: Comprehensive validation before any changes
2. **Backup Creation**: Automatic backup of current configuration  
3. **Temporary Write**: Write new configuration to temporary file
4. **Atomic Rename**: Atomic rename to replace current configuration
5. **Health Check**: Verify OpenClaw can start with new configuration
6. **Rollback on Failure**: Automatic rollback if health check fails

### Health Check Implementation

Health checks verify that:
- Configuration loads successfully
- All required dependencies are available  
- Validation passes completely
- No startup-blocking errors occur

### Backup Format

Backups include:
- **Configuration data**: Full JSON configuration
- **Metadata**: Timestamp, hash, notes, health status
- **Versioning**: Backup ID with timestamp and random suffix
- **Cleanup**: Automatic cleanup of old backups

This atomic configuration management system ensures OpenClaw can safely evolve its configuration while maintaining system reliability and providing recovery mechanisms for any failure scenarios.