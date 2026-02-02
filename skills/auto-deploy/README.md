# OpenClaw Auto-Deployment Skill

Automatically deploy OpenClaw on Linux servers with minimal manual intervention.

## Quick Start

```bash
# Run the auto-deployment wizard
node /usr/local/lib/node_modules/openclaw/skills/auto-deploy/index.js

# Or from OpenClaw
/run auto-deploy
```

## What It Does

This skill automates the complete OpenClaw installation process:

### ✨ Features

- **OS Detection**: Automatically detects your Linux distribution
- **Prerequisites Check**: Verifies Node.js 22+, disk space, RAM
- **Auto-Installation**: Installs Node.js if missing
- **Configuration Wizard**: Interactive setup for gateway, model, and API keys
- **Service Management**: Configures systemd service automatically
- **Verification**: Runs post-install validation checks

### 🖥️ Supported Systems

- OpenCloudOS 9+
- RHEL 9+
- CentOS 7+
- Ubuntu 20.04+
- Debian 11+

## Usage Examples

### Example 1: Fresh Server Installation

```bash
$ node /usr/local/lib/node_modules/openclaw/skills/auto-deploy/index.js

╔═══════════════════════════════════════════════════════════════╗
║          🦞 OpenClaw Auto-Deployment                         ║
╚═══════════════════════════════════════════════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Phase 1: Environment Detection
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

═════════════════════════════════════════
🖥️  Environment Detection Report
═════════════════════════════════════════

OS: Ubuntu 22.04.3 LTS
Kernel: Linux x86_64
Supported: ✅ Yes

Software:
  Node.js: ❌ Not installed
  Git: ❌ Not installed

Resources:
  Disk: 50G available (10% used)
  RAM: 2.0Gi total
  Network: ✅ Connected

⚠️  Issues found:
   - Node.js 22+ required
   - Git required
═════════════════════════════════════════

Continue with installation? (y/N): y
```

### Example 2: Skip to Configuration Only

```bash
# If OpenClaw is already installed, just configure
node /usr/local/lib/node_modules/openclaw/skills/auto-deploy/index.js --skip-install
```

## Manual Component Usage

You can also run individual components:

```bash
# Environment detection only
node /usr/local/lib/node_modules/openclaw/skills/auto-deploy/lib/detector.js

# Installation only
node /usr/local/lib/node_modules/openclaw/skills/auto-deploy/lib/installer.js

# Configuration wizard only
node /usr/local/lib/node_modules/openclaw/skills/auto-deploy/lib/configurator.js

# Verification only
node /usr/local/lib/node_modules/openclaw/skills/auto-deploy/lib/validator.js
```

## What Gets Installed

1. **Node.js 22.x** (if not present)
2. **Git** (if not present)
3. **OpenClaw** (latest version)
4. **Systemd service** (auto-start on boot)

## Configuration

The wizard will prompt you for:

### Gateway Settings
- Mode: Local or Remote
- Auth Token: Auto-generated or custom
- Port: Default 18789

### Model Settings
- Provider: Zhipu AI, OpenAI, Anthropic, or Custom
- Model: e.g., GLM-4.7, GPT-4, Claude
- API Key: Your provider API key

### Optional: Telegram
- Bot Token
- Chat ID

## Post-Installation

After successful deployment:

```bash
# Start the gateway
openclaw gateway start

# Enable auto-start
systemctl enable openclaw-gateway
systemctl start openclaw-gateway

# Access dashboard locally
http://localhost:18789?token=<YOUR_TOKEN>

# Or via SSH tunnel
ssh -L 8888:localhost:18789 root@<server-ip>
# Then: http://localhost:8888?token=<YOUR_TOKEN>
```

## Troubleshooting

### Installation Fails

Check the error message. Common issues:
- **Network connectivity**: Ensure server can access internet
- **Permissions**: Run as root or with sudo
- **Disk space**: Need at least 10GB free

### Service Won't Start

```bash
# Check logs
journalctl -u openclaw-gateway -f

# Verify config
cat ~/.openclaw/config.json

# Check port
netstat -tuln | grep 18789
```

### Permission Errors

```bash
# Fix permissions
chmod -R 700 ~/.openclaw
```

## Advanced Usage

### Non-Interactive Mode

For automated deployments:

```javascript
const { quickDeploy } = require('./index.js');

await quickDeploy({
  gateway: {
    mode: 'local',
    port: 18789,
    token: 'your-token'
  },
  model: {
    provider: 'zhipu',
    model: 'zhipu/GLM-4.7',
    apiKey: 'your-api-key'
  }
});
```

## Contributing

This skill is part of OpenClaw. Contributions welcome!

- GitHub: https://github.com/alijiujiu123/openclaw
- Issue: https://github.com/alijiujiu123/openclaw/issues/1

## License

Same as OpenClaw (MIT).
