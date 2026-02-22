# OpenClaw Doctor Scripts

Diagnostic and validation tools for troubleshooting OpenClaw issues.

## Purpose

These scripts help:

- **Validate** configuration before problems occur
- **Diagnose** issues quickly when things go wrong
- **Fix** common problems automatically
- **Provide** actionable guidance with clear next steps

## Quick Start

```bash
# Validate your entire configuration
./scripts/doctor/validate-config.sh

# Check reverse proxy setup
./scripts/doctor/check-reverse-proxy.sh

# Debug Telegram polling issues
./scripts/doctor/debug-telegram-polling.sh

# Test model access before configuring
./scripts/doctor/test-model-access.sh amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0

# Safely set a model with validation
./scripts/doctor/safe-set-model.sh amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0

# Transition Telegram between modes
./scripts/doctor/telegram-mode-transition.sh
```

## Scripts

### Configuration Validation

#### `validate-config.sh`

Comprehensive configuration validator with user-friendly error messages.

**Checks:**

- dmPolicy + allowFrom consistency for all channels
- Model ID validity
- Gateway auth configuration for reverse proxies
- Provides exact commands to fix issues

**When to Use:**

- Before starting gateway
- After config changes
- When troubleshooting

**Example:**

```bash
./scripts/doctor/validate-config.sh

# Output:
# ✅ Telegram: dmPolicy and allowFrom are consistent
# ✅ Model exists in catalog
# ⚠️  Gateway bind warning...
```

**Related:** GitHub Issue #20520

---

### Model Validation

#### `test-model-access.sh <model-id>`

Tests if a model ID is valid and accessible.

**Features:**

- Checks model exists in catalog
- Suggests similar models if typo detected
- Provider-specific auth testing (Bedrock, OpenAI)
- Tests actual model invocation for AWS Bedrock
- Detailed troubleshooting guidance

**When to Use:**

- Before configuring a model
- When getting "model not found" errors
- To verify provider access

**Example:**

```bash
./scripts/doctor/test-model-access.sh amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0

# Output:
# ✅ Model found in catalog
# ✅ AWS credentials valid (Account: 123456789)
# ✅ Model invocation successful
```

**Related:** GitHub Issue #20522

#### `safe-set-model.sh <model-id>`

Validates model before setting it in config.

**Features:**

- Runs full model validation first
- Prevents invalid models from being saved
- Shows current vs. new model
- Prompts for confirmation
- Fail-fast approach

**Example:**

```bash
./scripts/doctor/safe-set-model.sh amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0

# Output:
# [Validation checks...]
# 📝 Current model: ...
#    New model: ...
#    Replace current model? [y/N]
```

**Related:** GitHub Issue #20522

---

### Reverse Proxy

#### `check-reverse-proxy.sh`

Validates OpenClaw configuration for reverse proxy use.

**Checks:**

- Gateway bind address
- allowInsecureAuth setting (required for proxies)
- trustedProxies configuration
- Authentication mode and token strength
- Port exposure and firewall rules
- Detects running reverse proxies

**When to Use:**

- Setting up Cloudflare Tunnel, nginx, Caddy, etc.
- Getting Error 1008 (device token mismatch)
- Dashboard auth issues

**Example:**

```bash
./scripts/doctor/check-reverse-proxy.sh

# Output:
# ✅ Bind: lan (network accessible)
# ❌ allowInsecureAuth: false
#
#    When using a reverse proxy that terminates TLS,
#    you MUST set allowInsecureAuth to true.
#
#    Fix:
#      openclaw config set gateway.controlUi.allowInsecureAuth true
```

**Related:** GitHub Issue #20524, [docs/gateway/reverse-proxy.md](../../docs/gateway/reverse-proxy.md)

---

### Telegram Troubleshooting

#### `debug-telegram-polling.sh`

Comprehensive diagnostic tool for Telegram polling issues.

**Checks:**

- Gateway and channel status
- Bot API connectivity
- Pending updates (shows if messages consumed but not processed)
- Webhook conflicts
- Access control configuration
- Recent logs analysis
- Agent invocations with messageChannel=telegram
- Offset file status

**When to Use:**

- Bot receives messages but doesn't respond
- After mode transitions
- Investigating Bug #20518

**Example:**

```bash
./scripts/doctor/debug-telegram-polling.sh

# Output:
# ✅ Gateway running
# ✅ Bot connected: @yourbot
# ✅ No webhook configured
# ❌ NO AGENT INVOCATIONS FOUND!
#
# 🔴 ISSUE: Messages not reaching agent (Bug #20518)
#    Workaround: ./scripts/troubleshooting/fix-telegram-polling.sh
```

**Related:** GitHub Issue #20518, [TELEGRAM_POLLING_BUG_ANALYSIS.md](../../TELEGRAM_POLLING_BUG_ANALYSIS.md)

#### `telegram-mode-transition.sh`

Safely transitions Telegram between webhook and polling modes.

**Features:**

- Detects current webhook status via Telegram API
- Determines target mode from config
- Automates webhook → polling transition:
  - Deletes webhook
  - Clears stale offset files
  - Restarts gateway
  - Verifies transition success
- Checks for stale offset files
- Provides guidance for polling → webhook

**When to Use:**

- Switching from webhook to polling mode
- Getting 409 conflicts
- After deleting webhook but still seeing errors

**Example:**

```bash
./scripts/doctor/telegram-mode-transition.sh

# Output:
# 📍 Current mode: WEBHOOK
# 🎯 Target mode from config: polling
#
# ⚠️  TRANSITION NEEDED: Webhook → Polling
#    Proceed with transition? [y/N] y
#
# [Automated transition...]
# ✅ Transition complete!
```

**Related:** GitHub Issue #20519

---

## Workflow Examples

### First-Time Setup

```bash
# 1. Validate configuration
./scripts/doctor/validate-config.sh

# 2. If using reverse proxy
./scripts/doctor/check-reverse-proxy.sh

# 3. Test model access
./scripts/doctor/test-model-access.sh <your-model-id>

# 4. Start gateway
systemctl --user start openclaw-gateway.service

# 5. Send test message
# 6. If Telegram doesn't work, debug it
./scripts/doctor/debug-telegram-polling.sh
```

### Troubleshooting Workflow

```bash
# Problem: Something isn't working

# Step 1: Run health check
../../scripts/health-check.sh

# Step 2: Run specific diagnostic
# - Config issues? → validate-config.sh
# - Telegram issues? → debug-telegram-polling.sh
# - Reverse proxy? → check-reverse-proxy.sh
# - Model issues? → test-model-access.sh

# Step 3: Follow the fix recommendations
# Each script provides exact commands to fix issues

# Step 4: Verify fix
# Re-run the diagnostic script
```

### Before Making Changes

```bash
# Before changing model
./scripts/doctor/test-model-access.sh <new-model-id>
./scripts/doctor/safe-set-model.sh <new-model-id>

# Before switching Telegram modes
./scripts/doctor/telegram-mode-transition.sh

# Before deploying behind reverse proxy
./scripts/doctor/check-reverse-proxy.sh
```

---

## Design Principles

1. **User-Friendly Errors**
   - Clear explanations, not cryptic messages
   - Exact commands to fix issues
   - Multiple solution paths when available

2. **Fail Fast**
   - Validate before applying changes
   - Prevent broken configurations
   - Catch errors at config time, not runtime

3. **Actionable Guidance**
   - Every error includes fix commands
   - Links to documentation
   - Related GitHub issues

4. **Safe Operations**
   - Non-destructive by default
   - Confirmation prompts for changes
   - Backup reminders

5. **Comprehensive Checks**
   - Don't just check one thing
   - Surface related issues
   - Provide context

---

## Related Documentation

- **Troubleshooting Scripts:** [../troubleshooting/](../troubleshooting/)
- **Config Error Guide:** [../../docs/troubleshooting/config-errors.md](../../docs/troubleshooting/config-errors.md)
- **Reverse Proxy Guide:** [../../docs/gateway/reverse-proxy.md](../../docs/gateway/reverse-proxy.md)
- **Telegram Bug Analysis:** [../../TELEGRAM_POLLING_BUG_ANALYSIS.md](../../TELEGRAM_POLLING_BUG_ANALYSIS.md)

---

## GitHub Issues Addressed

- **#20518** - Telegram polling drops messages (Critical)
- **#20519** - Webhook-to-polling transition issues
- **#20520** - Config validation error messages
- **#20522** - Model ID validation missing
- **#20524** - Dashboard auth with reverse proxy

---

## Contributing

Found a bug? Have a useful diagnostic script?

1. Test on actual hardware
2. Include clear error messages
3. Provide fix commands
4. Document when to use it
5. Submit a PR!

See: [../../CONTRIBUTING.md](../../CONTRIBUTING.md)
