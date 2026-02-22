# Configuration Error Guide

Common OpenClaw configuration errors and how to fix them.

## dmPolicy="open" requires allowFrom to include "\*"

### Error Message

```
Error: Config validation failed: channels.telegram.allowFrom:
channels.telegram.dmPolicy="open" requires channels.telegram.allowFrom
to include "*"
```

### What It Means

When you set `dmPolicy: "open"`, you're telling OpenClaw to accept messages from anyone. However, the `allowFrom` field specifies which users are allowed. These settings conflict.

### Current Configuration

```json
{
  "channels": {
    "telegram": {
      "dmPolicy": "open",
      "allowFrom": [] // or ["123456789"]
    }
  }
}
```

### Solution 1: Allow All Users (Recommended for open bots)

```bash
openclaw config set channels.telegram.allowFrom '["*"]'
```

**Result:**

```json
{
  "channels": {
    "telegram": {
      "dmPolicy": "open",
      "allowFrom": ["*"] // ✅ Allows everyone
    }
  }
}
```

### Solution 2: Require Pairing (Recommended for private bots)

```bash
openclaw config set channels.telegram.dmPolicy "pairing"
```

**Result:**

```json
{
  "channels": {
    "telegram": {
      "dmPolicy": "pairing", // ✅ Requires user pairing first
      "allowFrom": []
    }
  }
}
```

### Understanding dmPolicy

| Policy    | Behavior                      | When to Use                    |
| --------- | ----------------------------- | ------------------------------ |
| `open`    | Accept messages from anyone   | Public bots, community servers |
| `pairing` | Require explicit user pairing | Private bots, personal use     |
| `closed`  | Reject all new conversations  | Testing, maintenance mode      |

---

## Model Not Found / Invalid Model ID

### Error Symptoms

- Agent invocations fail
- Logs show "Model not found" or similar errors
- Bot receives messages but doesn't respond
- No clear error during configuration

### Why This Happens

OpenClaw accepts any model ID during configuration without validating it exists. Errors only appear at runtime when the agent tries to use the model.

### How to Check

```bash
# See your configured model
openclaw config get agents.defaults.model.primary

# List available models
openclaw models list

# Test model access
./scripts/troubleshooting/test-bedrock-models.sh  # For Bedrock users
```

### Common Mistakes

#### 1. Typo in Model ID

**Wrong:**

```json
"model": {
  "primary": "amazon-bedrock/us.anthropic.claude-opus-4-6-v1:0"
}
```

**Correct:**

```json
"model": {
  "primary": "amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0"
}
```

Note: Opus 4.6 doesn't exist yet. Current latest is Opus 4.5.

#### 2. Missing Region Prefix (AWS Bedrock)

When using AWS Bedrock in `us-east-1`, most models require a region prefix.

**Wrong:**

```json
"model": {
  "primary": "amazon-bedrock/anthropic.claude-opus-4-5-20251101-v1:0"
}
```

**Correct:**

```json
"model": {
  "primary": "amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0"
}
```

Region prefixes:

- `us.` - US West (Oregon)
- `eu.` - Europe (Frankfurt)
- `ap.` - Asia Pacific (Tokyo)

#### 3. Missing Provider Prefix

**Wrong:**

```json
"model": {
  "primary": "claude-opus-4-5"
}
```

**Correct:**

```json
"model": {
  "primary": "amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0"
}
```

### Solution

1. **List available models:**

   ```bash
   openclaw models list | grep -i claude
   ```

2. **Copy exact model ID from list:**

   ```bash
   openclaw config set agents.defaults.model.primary "amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0"
   ```

3. **Test the model:**

   ```bash
   # For Bedrock
   ./scripts/troubleshooting/test-bedrock-models.sh

   # Or send a test message via your channel
   ```

### Validation Script

Run the validation script before starting the gateway:

```bash
./scripts/doctor/validate-config.sh
```

This checks for common model configuration issues and suggests fixes.

---

## Dashboard Authentication Fails (Error 1008)

### Dashboard Error Message

```
Error 1008: Device token mismatch
```

### Dashboard Symptoms

- Can't access dashboard at `http://localhost:3030` (or LAN IP)
- Authentication fails even with correct token
- Worked before, stopped after config change

### Cause

Using a reverse proxy (Cloudflare Tunnel, nginx, Caddy, etc.) that terminates TLS. OpenClaw thinks requests are insecure and rejects them.

### Dashboard Current Configuration

```json
{
  "gateway": {
    "bind": "lan",
    "controlUi": {
      "allowInsecureAuth": false // or not set
    }
  }
}
```

### Dashboard Solution

```bash
openclaw config set gateway.controlUi.allowInsecureAuth true
systemctl --user restart openclaw-gateway.service
```

**Result:**

```json
{
  "gateway": {
    "bind": "lan",
    "controlUi": {
      "allowInsecureAuth": true // ✅ Allows auth from reverse proxy
    }
  }
}
```

### Why This is Safe

- Your reverse proxy (Cloudflare Tunnel, nginx) handles TLS
- Connection between reverse proxy and OpenClaw is local/trusted
- End-to-end encryption is maintained by the reverse proxy

### Security Note

Only use `allowInsecureAuth: true` when:

- Behind a reverse proxy that handles TLS
- On a trusted local network
- With proper firewall rules

Don't use it for direct internet exposure without TLS.

---

## Telegram Bot Not Responding

### Telegram Symptoms

- Bot receives messages (Telegram shows "delivered")
- No agent invocations in logs
- `openclaw channels status` shows "running"
- `journalctl` shows no errors

### Telegram Diagnosis

```bash
# Check if bot is running
openclaw channels status

# Check for agent invocations
journalctl --user -u openclaw-gateway -f | grep "messageChannel=telegram"

# If you see no "messageChannel=telegram" entries, polling is broken
```

### Telegram Solution

**Quick Fix:**

```bash
./scripts/troubleshooting/fix-telegram-polling.sh
```

**Manual Fix:**

```bash
# Stop gateway
systemctl --user stop openclaw-gateway.service

# Delete offset file
rm ~/.openclaw/telegram/update-offset-default.json

# Remove webhook (if exists)
BOT_TOKEN=$(openclaw config get channels.telegram.botToken | tr -d '"')
curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook"

# Restart gateway
systemctl --user start openclaw-gateway.service

# Test by sending a message
```

### Telegram Related Issue

- **GitHub Issue:** #20518
- **Status:** Workaround available, core fix needed
- **Affects:** Telegram polling mode

---

## Webhook to Polling Transition (409 Conflict)

### Webhook Error Message

```
Telegram getUpdates conflict: Call to 'getUpdates' failed!
(409: Conflict: can't use getUpdates method while webhook is active;
use deleteWebhook to delete the webhook first); retrying in 30s.
```

### Webhook Cause

Switched from webhook to polling mode, but offset file retains stale state. Even after deleting webhook, conflict persists.

### Webhook Solution

```bash
# Delete webhook
BOT_TOKEN=$(openclaw config get channels.telegram.botToken | tr -d '"')
curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook"

# Delete offset file (critical step)
rm ~/.openclaw/telegram/update-offset-default.json

# Restart gateway
systemctl --user restart openclaw-gateway.service
```

### Prevention

When switching Telegram modes:

1. Delete webhook first (if going to polling)
2. Delete offset file
3. Update configuration
4. Restart gateway

### Webhook Related Issue

- **GitHub Issue:** #20519
- **Status:** Manual workaround required
- **Affects:** Mode transitions

---

## Using Validation Tools

### Config Validator

Checks for common configuration issues:

```bash
./scripts/doctor/validate-config.sh
```

Provides:

- User-friendly error messages
- Exact commands to fix issues
- Alternative solutions

### Health Check

Comprehensive system check:

```bash
./scripts/health-check.sh
```

Checks:

- OpenClaw installation
- Gateway status
- Channel configuration
- Model access
- System resources

### When to Use

- **Before starting gateway** - catch config errors early
- **After config changes** - verify changes are valid
- **Troubleshooting** - diagnose issues quickly

---

## See Also

- [Raspberry Pi Troubleshooting](../platforms/raspberry-pi.md#troubleshooting)
- [AWS Bedrock Setup](../providers/bedrock.md)
- [Telegram Channel Guide](../channels/telegram.md)
- [GitHub Issues](https://github.com/openclaw/openclaw/issues)
