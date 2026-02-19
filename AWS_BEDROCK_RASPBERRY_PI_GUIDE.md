# OpenClaw Setup Guide: AWS Bedrock + Raspberry Pi

Complete guide for running OpenClaw with AWS Bedrock on Raspberry Pi, tested on Raspberry Pi 5 (8GB RAM).

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Hardware Requirements](#hardware-requirements)
3. [Initial Setup](#initial-setup)
4. [AWS Bedrock Configuration](#aws-bedrock-configuration)
5. [Channel Setup](#channel-setup)
6. [Troubleshooting](#troubleshooting)
7. [Performance Optimization](#performance-optimization)

---

## Prerequisites

### Required Accounts
- AWS Account with Bedrock access
- Telegram Bot Token (optional, for Telegram channel)
- Slack App credentials (optional, for Slack channel)

### AWS Bedrock Model Access

Before starting, request model access in AWS Bedrock:

1. Go to [AWS Bedrock Console](https://console.aws.amazon.com/bedrock)
2. Navigate to **Model access** (left sidebar)
3. Click **Manage model access**
4. Enable access for:
   - Claude Opus 4.5
   - Claude Sonnet 4.6
   - Claude Haiku 4.5
   - (Any other models you want to use)
5. Wait for approval (usually instant for Claude models)

---

## Hardware Requirements

### Minimum Requirements
- **Device:** Raspberry Pi 4 (4GB RAM) or newer
- **Storage:** 16GB microSD card (32GB+ recommended)
- **Network:** Stable internet connection
- **Power:** Official Raspberry Pi power supply

### Recommended Configuration
- **Device:** Raspberry Pi 5 (8GB RAM)
- **Storage:** 64GB+ microSD card or SSD
- **Cooling:** Active cooling (fan/heatsink) for sustained workloads
- **Power:** Official 27W USB-C power supply

### Tested Configuration
```
Device: Raspberry Pi 5 (8GB RAM)
OS: Raspberry Pi OS (64-bit, Debian 12 Bookworm)
Kernel: 6.12.47+rpt-rpi-2712
Node.js: v22.22.0
OpenClaw: v2026.2.17
```

---

## Initial Setup

### 1. System Preparation

Update your Raspberry Pi:
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl build-essential
```

### 2. Install Node.js

Install Node.js 22.x:
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

Verify installation:
```bash
node --version  # Should show v22.x.x
npm --version
```

### 3. Install OpenClaw

```bash
npm install -g openclaw
```

Verify installation:
```bash
openclaw --version  # Should show v2026.2.17 or newer
```

### 4. Run Setup Wizard

```bash
openclaw wizard
```

Follow the prompts to configure your gateway.

---

## AWS Bedrock Configuration

### 1. Install AWS CLI

```bash
curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install
```

Verify:
```bash
aws --version
```

### 2. Configure AWS Credentials

Create IAM access keys with Bedrock permissions:

**IAM Policy Required:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:ListFoundationModels"
      ],
      "Resource": "*"
    }
  ]
}
```

Configure AWS CLI:
```bash
aws configure
```

Enter:
- AWS Access Key ID
- AWS Secret Access Key
- Default region: `us-east-1` (recommended)
- Default output format: `json`

### 3. Test Bedrock Access

```bash
aws bedrock list-foundation-models --region us-east-1
```

Should list available models.

### 4. Configure OpenClaw for AWS Bedrock

#### Enable Bedrock Discovery

```bash
openclaw config set models.bedrockDiscovery.enabled true
openclaw config set models.bedrockDiscovery.region us-east-1
```

#### List Available Models

```bash
openclaw models list | grep bedrock
```

You should see output like:
```
amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0
amazon-bedrock/us.anthropic.claude-sonnet-4-6
amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0
...
```

#### Set Primary Model

**IMPORTANT:** Use the `us.` prefix for cross-region inference in us-east-1:

```bash
openclaw config set agents.defaults.model.primary \
  "amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0"
```

#### Configure Model for Claude Code (if using)

Set environment variables in your shell profile (`~/.bashrc` or `~/.zshrc`):

```bash
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION=us-east-1
export ANTHROPIC_MODEL='global.anthropic.claude-sonnet-4-5-20250929-v1:0'
export ANTHROPIC_SMALL_FAST_MODEL='us.anthropic.claude-haiku-4-5-20251001-v1:0'
```

Reload your shell:
```bash
source ~/.bashrc
```

### 5. Available AWS Bedrock Models

All Claude models tested and working on Raspberry Pi 5:

| Model | Model ID | Use Case |
|-------|----------|----------|
| **Claude Opus 4.5** | `us.anthropic.claude-opus-4-5-20251101-v1:0` | Most capable, best for complex tasks |
| **Claude Opus 4.1** | `us.anthropic.claude-opus-4-1-20250805-v1:0` | Previous Opus version |
| **Claude Sonnet 4.6** | `us.anthropic.claude-sonnet-4-6` | Balanced performance/cost |
| **Claude Sonnet 4.5** | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | Fast, efficient |
| **Claude Sonnet 4** | `us.anthropic.claude-sonnet-4-20250514-v1:0` | Reliable mid-tier |
| **Claude Haiku 4.5** | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Fastest, cheapest |
| **Claude 3.7 Sonnet** | `us.anthropic.claude-3-7-sonnet-20250219-v1:0` | Latest 3.x series |
| **Claude 3.5 Sonnet v2** | `us.anthropic.claude-3-5-sonnet-20241022-v2:0` | Proven stable |
| **Claude 3.5 Haiku** | `us.anthropic.claude-3-5-haiku-20241022-v1:0` | Budget option |

**Note:** The `us.` prefix is required for cross-region inference when using us-east-1 as your base region.

---

## Channel Setup

### Telegram Channel

#### 1. Create Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Follow prompts to name your bot
4. Save the bot token (format: `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz`)

#### 2. Configure OpenClaw

```bash
# Set bot token
openclaw config set channels.telegram.botToken "YOUR_BOT_TOKEN_HERE"

# Allow all users to message the bot
openclaw config set channels.telegram.dmPolicy "open"
openclaw config set channels.telegram.allowFrom '["*"]'

# Optional: Allow group chats
openclaw config set channels.telegram.groupPolicy "open"
```

#### 3. Enable Telegram Plugin

```bash
openclaw config set plugins.entries.telegram.enabled true
```

#### 4. Restart Gateway

```bash
systemctl --user restart openclaw-gateway.service
```

Or if not using systemd:
```bash
openclaw gateway stop
openclaw gateway start
```

#### 5. Test Telegram Bot

1. Open Telegram
2. Search for your bot by username
3. Send a message: "Hello"
4. Bot should respond with Claude AI

#### Troubleshooting Telegram

If bot doesn't respond:

**Check Status:**
```bash
openclaw channels status
```

Should show:
```
- Telegram default: enabled, configured, running, mode:polling
```

**Check Logs:**
```bash
tail -f ~/.openclaw/logs/*.log | grep telegram
```

**Common Fix:**
If messages aren't being processed, reset the Telegram state:

```bash
# Stop gateway
systemctl --user stop openclaw-gateway.service

# Delete offset file
rm ~/.openclaw/telegram/update-offset-default.json

# Start gateway
systemctl --user start openclaw-gateway.service
```

---

### Slack Channel

#### 1. Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** → **From scratch**
3. Name your app (e.g., "OpenClaw AI")
4. Select your workspace

#### 2. Configure OAuth & Permissions

Add these Bot Token Scopes:
```
app_mentions:read
channels:history
channels:join
channels:read
chat:write
files:read
groups:history
groups:read
im:history
im:read
im:write
reactions:write
users:read
```

#### 3. Enable Socket Mode

1. Go to **Settings** → **Socket Mode**
2. Enable Socket Mode
3. Generate App-Level Token (name: `websocket`, scope: `connections:write`)
4. Save the token (format: `xapp-...`)

#### 4. Install App to Workspace

1. Go to **OAuth & Permissions**
2. Click **Install to Workspace**
3. Authorize the app
4. Copy the Bot User OAuth Token (format: `xoxb-...`)

#### 5. Configure OpenClaw

```bash
# Set tokens
openclaw config set channels.slack.botToken "xoxb-YOUR-BOT-TOKEN"
openclaw config set channels.slack.appToken "xapp-YOUR-APP-TOKEN"

# Set mode to socket
openclaw config set channels.slack.mode "socket"

# Allow all users and channels
openclaw config set channels.slack.dmPolicy "open"
openclaw config set channels.slack.groupPolicy "open"
openclaw config set channels.slack.allowFrom '["*"]'
```

#### 6. Subscribe to Events

In Slack App settings:
1. Go to **Event Subscriptions**
2. Enable Events
3. Add Bot Events:
   - `app_mention`
   - `message.channels`
   - `message.groups`
   - `message.im`

#### 7. Restart Gateway

```bash
systemctl --user restart openclaw-gateway.service
```

#### 8. Test Slack Integration

1. Open your Slack workspace
2. Send a DM to your bot
3. Or mention the bot in a channel: `@YourBot hello`
4. Bot should respond with Claude AI

---

## Gateway Setup with Systemd

### Create Systemd Service

Create service file:
```bash
openclaw gateway install
```

This creates `~/.config/systemd/user/openclaw-gateway.service`

### Manage Gateway Service

```bash
# Start gateway
systemctl --user start openclaw-gateway.service

# Stop gateway
systemctl --user stop openclaw-gateway.service

# Restart gateway
systemctl --user restart openclaw-gateway.service

# Check status
systemctl --user status openclaw-gateway.service

# Enable auto-start on boot
systemctl --user enable openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

---

## Troubleshooting

### General Diagnostics

```bash
# Run full diagnostics
openclaw doctor

# Check channel status
openclaw channels status --probe

# List active models
openclaw models list

# View logs
tail -f /tmp/openclaw/*.log
```

### Common Issues

#### Issue: "Model not found" error

**Problem:** Model ID doesn't exist or lacks proper prefix

**Solution:**
```bash
# List available models
openclaw models list | grep bedrock

# Use model with us. prefix for us-east-1
openclaw config set agents.defaults.model.primary \
  "amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0"
```

#### Issue: Telegram bot not responding

**Problem:** Offset file corruption or webhook conflict

**Solution:**
```bash
systemctl --user stop openclaw-gateway.service
rm ~/.openclaw/telegram/update-offset-default.json
systemctl --user start openclaw-gateway.service
```

#### Issue: "401 Unauthorized" with AWS Bedrock

**Problem:** Invalid AWS credentials or missing permissions

**Solution:**
```bash
# Verify credentials
aws sts get-caller-identity

# Test Bedrock access
aws bedrock list-foundation-models --region us-east-1

# Re-configure if needed
aws configure
```

#### Issue: High memory usage on Raspberry Pi

**Problem:** Multiple model providers running discovery

**Solution:**
```bash
# Disable unused providers
openclaw config set models.providers.openai.enabled false
openclaw config set models.providers.huggingface.enabled false

# Keep only Bedrock
openclaw config set models.providers.amazon-bedrock.enabled true

# Restart gateway
systemctl --user restart openclaw-gateway.service
```

#### Issue: Gateway not accessible via web UI

**Problem:** Firewall or authentication configuration

**Solution:**
```bash
# Allow LAN access
openclaw config set gateway.bind "lan"

# For reverse proxy setups (Cloudflare, nginx)
openclaw config set gateway.controlUi.allowInsecureAuth true

# Set auth token
openclaw config set gateway.auth.mode "token"
openclaw config set gateway.auth.token "YOUR_SECURE_TOKEN_HERE"

# Restart gateway
systemctl --user restart openclaw-gateway.service
```

Access dashboard at: `http://RASPBERRY_PI_IP:18789/?auth=YOUR_TOKEN`

---

## Performance Optimization

### Raspberry Pi Specific Tuning

#### 1. Reduce Concurrent Agents

```bash
# Limit concurrent agents
openclaw config set agents.defaults.maxConcurrent 2

# Limit subagents
openclaw config set agents.defaults.subagents.maxConcurrent 4
```

#### 2. Enable Safeguard Compaction

```bash
openclaw config set agents.defaults.compaction.mode "safeguard"
```

This reduces memory usage during long conversations.

#### 3. Use Faster Models for Quick Tasks

Configure model tiers:
```bash
# Primary: Opus for complex tasks
openclaw config set agents.defaults.model.primary \
  "amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0"

# Fast: Sonnet for quick responses
openclaw config set agents.defaults.model.fast \
  "amazon-bedrock/us.anthropic.claude-sonnet-4-6"
```

#### 4. Disable Model Discovery Timeout

If you see discovery timeouts:
```bash
openclaw config set models.providers.huggingface.enabled false
```

#### 5. Monitor Resource Usage

```bash
# Check memory usage
free -h

# Check CPU load
top

# Check OpenClaw process
ps aux | grep openclaw

# Monitor logs for errors
journalctl --user -u openclaw-gateway.service -f
```

---

## Advanced Configuration

### Using Cloudflare Tunnel

Expose your OpenClaw instance securely:

#### 1. Install Cloudflare Tunnel

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb \
  -o cloudflared.deb
sudo dpkg -i cloudflared.deb
```

#### 2. Authenticate

```bash
cloudflared tunnel login
```

#### 3. Create Tunnel

```bash
cloudflared tunnel create openclaw
```

#### 4. Configure Tunnel

Create `~/.cloudflared/openclaw-config.yml`:
```yaml
tunnel: YOUR_TUNNEL_ID
credentials-file: /home/admin/.cloudflared/YOUR_TUNNEL_ID.json

ingress:
  - hostname: openclaw.yourdomain.com
    service: http://localhost:18789
  - service: http_status:404
```

#### 5. Route DNS

```bash
cloudflared tunnel route dns openclaw openclaw.yourdomain.com
```

#### 6. Run Tunnel

```bash
cloudflared tunnel --config ~/.cloudflared/openclaw-config.yml run openclaw
```

Or create systemd service for auto-start.

#### 7. Configure OpenClaw for Tunnel

```bash
openclaw config set gateway.controlUi.allowInsecureAuth true
openclaw config set gateway.trustedProxies '["127.0.0.1"]'
systemctl --user restart openclaw-gateway.service
```

Access at: `https://openclaw.yourdomain.com/?auth=YOUR_TOKEN`

---

## Security Best Practices

### 1. Strong Authentication

```bash
# Generate secure token
TOKEN=$(openssl rand -hex 32)

# Set token
openclaw config set gateway.auth.token "$TOKEN"
```

### 2. Restrict Access

```bash
# Bind to localhost only (if using tunnel)
openclaw config set gateway.bind "localhost"

# Or specific IP
openclaw config set gateway.bind "192.168.1.100"
```

### 3. Firewall Configuration

```bash
# Allow only SSH and OpenClaw
sudo ufw allow 22/tcp
sudo ufw allow 18789/tcp
sudo ufw enable
```

### 4. Keep System Updated

```bash
# Update Raspberry Pi OS
sudo apt update && sudo apt upgrade -y

# Update OpenClaw
npm update -g openclaw

# Restart services
systemctl --user restart openclaw-gateway.service
```

---

## Backup and Recovery

### Backup Configuration

```bash
# Backup OpenClaw config
cp ~/.openclaw/openclaw.json ~/openclaw-backup-$(date +%Y%m%d).json

# Backup all OpenClaw data
tar -czf ~/openclaw-data-$(date +%Y%m%d).tar.gz ~/.openclaw/
```

### Restore Configuration

```bash
# Restore config
cp ~/openclaw-backup-YYYYMMDD.json ~/.openclaw/openclaw.json

# Restart gateway
systemctl --user restart openclaw-gateway.service
```

---

## Performance Benchmarks

Tested on Raspberry Pi 5 (8GB RAM):

| Operation | Average Time | Notes |
|-----------|--------------|-------|
| Gateway startup | 3-5 seconds | Initial model loading |
| First message response | 5-8 seconds | Claude Opus 4.5 |
| Subsequent responses | 3-5 seconds | With context |
| Channel switch | <1 second | Telegram/Slack/Web |
| Model discovery | 30-60 seconds | One-time on first run |
| Memory usage (idle) | ~400-600 MB | Gateway + 1 agent |
| Memory usage (active) | ~800-1200 MB | Gateway + 3 concurrent agents |

---

## Useful Commands Reference

```bash
# Configuration
openclaw config get <path>                   # Get config value
openclaw config set <path> <value>           # Set config value
openclaw config show                         # Show full config

# Models
openclaw models list                         # List all available models
openclaw models set <model-id>               # Set primary model
openclaw models providers                    # List providers

# Channels
openclaw channels status                     # Check channel status
openclaw channels login                      # Login to channel (WhatsApp, etc.)
openclaw channels logout <channel>           # Logout from channel

# Gateway
openclaw gateway start                       # Start gateway
openclaw gateway stop                        # Stop gateway
openclaw gateway status                      # Check gateway status
openclaw gateway logs                        # View gateway logs

# Diagnostics
openclaw doctor                              # Run diagnostics
openclaw doctor --fix                        # Auto-fix common issues

# Systemd (if installed)
systemctl --user start openclaw-gateway      # Start service
systemctl --user stop openclaw-gateway       # Stop service
systemctl --user restart openclaw-gateway    # Restart service
systemctl --user status openclaw-gateway     # Check service status
systemctl --user enable openclaw-gateway     # Enable auto-start
journalctl --user -u openclaw-gateway -f     # View live logs
```

---

## Additional Resources

- **OpenClaw Documentation:** https://docs.openclaw.ai
- **AWS Bedrock Docs:** https://docs.aws.amazon.com/bedrock/
- **Raspberry Pi Forums:** https://forums.raspberrypi.com
- **OpenClaw GitHub:** https://github.com/openclaw/openclaw
- **AWS Bedrock Model IDs:** https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html

---

## Support and Community

- GitHub Issues: https://github.com/openclaw/openclaw/issues
- Discussions: https://github.com/openclaw/openclaw/discussions

---

## License

This guide is provided as-is under MIT License.

OpenClaw is licensed under Apache-2.0.

---

**Last Updated:** February 18, 2026
**Tested Version:** OpenClaw v2026.2.17
**Platform:** Raspberry Pi 5 (8GB) + AWS Bedrock
