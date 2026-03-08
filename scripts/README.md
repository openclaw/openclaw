# OpenClaw Scripts

Utility scripts for OpenClaw deployment, troubleshooting, and monitoring.

## Setup Scripts

### [setup/raspberry-pi-quickstart.sh](./setup/raspberry-pi-quickstart.sh)

Automated setup for Raspberry Pi + AWS Bedrock

**What it does:**

- Installs Node.js 22
- Configures swap memory
- Installs AWS CLI (ARM64)
- Installs OpenClaw
- Configures Bedrock discovery

**Usage:**

```bash
./scripts/setup/raspberry-pi-quickstart.sh
```

**Time:** ~5 minutes (vs 30+ minutes manual setup)

---

## Troubleshooting Scripts

### [troubleshooting/fix-telegram-polling.sh](./troubleshooting/fix-telegram-polling.sh)

Fix Telegram bot not responding to messages

**Symptoms:**

- Bot receives messages but doesn't respond
- No agent invocations in logs
- `openclaw channels status` shows "running"

**What it does:**

- Stops gateway
- Deletes corrupted offset file
- Removes active webhooks
- Restarts gateway

**Usage:**

```bash
./scripts/troubleshooting/fix-telegram-polling.sh
```

**Related:** [Issue #20503](https://github.com/openclaw/openclaw/issues/20503)

### [troubleshooting/test-bedrock-models.sh](./troubleshooting/test-bedrock-models.sh)

Test AWS Bedrock model access and configuration

**What it does:**

- Verifies AWS credentials
- Lists available Claude models
- Shows correct model IDs with region prefix
- Tests model invocation
- Provides troubleshooting guidance

**Usage:**

```bash
./scripts/troubleshooting/test-bedrock-models.sh
```

**Related:** [Issue #20505](https://github.com/openclaw/openclaw/issues/20505), [Issue #20507](https://github.com/openclaw/openclaw/issues/20507)

---

## Monitoring Scripts

### [raspberry-pi-monitor.sh](./raspberry-pi-monitor.sh)

Monitor Raspberry Pi performance for OpenClaw

**What it shows:**

- System info (CPU, memory, disk)
- Temperature with throttling detection
- OpenClaw service status
- Memory and CPU usage
- Network connectivity
- Optimization suggestions

**Usage:**

```bash
./scripts/raspberry-pi-monitor.sh
```

**Useful for:**

- Troubleshooting performance issues
- Monitoring resource usage
- Detecting thermal throttling
- Checking if optimizations are needed

### [health-check.sh](./health-check.sh)

Comprehensive health check for all OpenClaw components

**What it checks:**

- OpenClaw installation
- Gateway service status
- Configuration validity
- Channel setup (Telegram, Slack)
- AWS Bedrock access
- System resources
- Network connectivity

**Usage:**

```bash
./scripts/health-check.sh
```

**Returns:** Exit code 0 (success) or 1 (failure) for automation

---

## Maintenance Scripts

### [backup-config.sh](./backup-config.sh)

Backup OpenClaw configuration and data

**What it does:**

- Creates timestamped backup archive
- Excludes logs and node_modules
- Auto-cleanup (keeps last 10 backups)
- Provides restore instructions

**Usage:**

```bash
./scripts/backup-config.sh
```

**Backup location:** `~/openclaw-backups/`

**Restore:**

```bash
systemctl --user stop openclaw-gateway.service
tar -xzf ~/openclaw-backups/openclaw-backup-TIMESTAMP.tar.gz -C ~
systemctl --user start openclaw-gateway.service
```

---

## Quick Reference

| Script                       | Purpose        | When to Use              |
| ---------------------------- | -------------- | ------------------------ |
| `raspberry-pi-quickstart.sh` | Initial setup  | First-time Pi setup      |
| `fix-telegram-polling.sh`    | Fix Telegram   | Bot not responding       |
| `test-bedrock-models.sh`     | Test Bedrock   | "Model not found" errors |
| `raspberry-pi-monitor.sh`    | Monitor system | Performance checks       |

---

## Requirements

### All Scripts

- Bash 4.0+
- OpenClaw installed

### Platform-Specific

- `raspberry-pi-monitor.sh`: Raspberry Pi only (uses `vcgencmd`)
- `raspberry-pi-quickstart.sh`: Raspberry Pi with 64-bit OS

### AWS Scripts

- `test-bedrock-models.sh`: AWS CLI, valid credentials

---

## Contributing

Found a bug or have a useful script? Submit a PR!

**Script Guidelines:**

- Include clear comments
- Add error handling (`set -e`)
- Provide usage instructions
- Test on target platform
- Document requirements

---

## See Also

- **Examples:** [../examples/](../examples/)
- **Raspberry Pi Guide:** [../docs/platforms/raspberry-pi.md](../docs/platforms/raspberry-pi.md)
- **AWS Bedrock Guide:** [../docs/providers/bedrock.md](../docs/providers/bedrock.md)
- **Bug Reports:** [../BUGS_IDENTIFIED.md](../BUGS_IDENTIFIED.md)
