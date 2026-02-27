---
title: Security Best Practices
description: Operational security guidance for OpenClaw deployments
---

# OpenClaw Security Best Practices

## API Key & Credential Management

### Never paste keys directly in chat

API keys entered into chat windows are stored in session logs, indexed by the memory system, and may appear in log output. Always use config or environment variables:

```bash
# Preferred: config system (stored in credential vault)
openclaw config set providers.anthropic.apiKey "<KEY>"
openclaw config set providers.openai.apiKey "<KEY>"

# Alternative: environment variable (not persisted)
export ANTHROPIC_API_KEY="<KEY>"
```

### Rotate credentials regularly

```bash
# Check which credentials are due for rotation
openclaw security credentials status

# Rotate a specific credential
openclaw security credentials rotate --name anthropic --scope provider

# Or use health --fix to rotate all overdue credentials at once
openclaw security health --fix
```

Recommended rotation schedule:

- **AI provider keys**: every 90 days
- **Channel bot tokens** (Telegram, Discord, Slack): every 90 days
- **Webhook secrets**: every 180 days
- **Immediately** if any exposure is suspected

### Check vault health

```bash
# Full security posture view
openclaw security health

# Credential vault details
openclaw security credentials status
```

The credential vault stores credentials using AES-256-GCM encryption (`~/.openclaw/vault/credentials.enc`). A tamper-evident audit log uses SHA-256 hash chains to detect unauthorised modifications. If audit integrity shows `BROKEN`, run `openclaw security audit --deep` immediately.

> **Critical — back up your vault key.**
> The encryption key is stored at `~/.openclaw/vault/.vault-key` (mode `0o600`).
> **Loss of this file renders all stored credentials permanently unrecoverable** — there is no recovery path without the key.
> Back up `.vault-key` alongside `credentials.enc` to a secure, offline location (e.g. encrypted USB, password manager attachment, or secrets manager).

---

## Skill Safety

Skills run as trusted code with access to your agent's tools and session context. Treat them as you would any software you install.

### Before installing any skill

```bash
# Scan a skill before installation
openclaw skill scan /path/to/skill

# Install with automatic scan (blocks on critical findings)
openclaw plugins install /path/to/skill
```

The scanner checks for:

- Sleeper agents (time-delayed code, cron triggers)
- Container escape attempts (Docker socket, namespace manipulation)
- Credential harvesting (keychain access, `.aws/credentials`, exfiltration endpoints)
- Webhook/DNS exfiltration patterns

### Trust hierarchy

1. **Build your own skills** — highest trust, you control the code
2. **Skills from known sources** — audit the code, check signatures
3. **Unknown third-party skills** — scan first, test in isolation, review manually

---

## Log & Session Hygiene

### Enable credential redaction

Ensure sensitive values are stripped from logs before they reach disk:

```bash
openclaw config set logging.redactSensitive on
```

This redacts API key patterns, OAuth tokens, and other credential-shaped strings from all log output.

### Review session files

Session transcripts in `~/.openclaw/agents/*/sessions/` contain the full conversation history. Scan for exposed credentials:

```bash
# Check for API key patterns in session files (count only — do not log output)
grep -r "sk-ant-\|sk-\|xoxb-\|xapp-" ~/.openclaw/agents/*/sessions/ 2>/dev/null | wc -l
```

If matches are found, consider pruning affected session files and rotating the exposed keys.

### Prune old sessions

```bash
# Remove session files older than 30 days
openclaw logs prune --older-than 30d
```

---

## Gateway Security

### Keep the gateway on loopback unless required

The default binding (`loopback`) restricts access to the local machine. Only expose to the network if needed:

```bash
# Check current binding and auth status
openclaw doctor

# Restrict to loopback
openclaw config set gateway.bind loopback
```

If network binding is required, always set authentication:

```bash
# Generate a strong auth token
openclaw doctor --fix

# Or set manually
openclaw config set gateway.auth.mode token
```

### Control UI access

The Control UI should only be accessible from trusted networks. When `gateway.bind` is set to `lan` or `custom`, ensure the auth token is strong and not shared.

---

## Channel Security

### Use allowlists, not open DM policies

Setting `dmPolicy: "open"` allows anyone who finds your bot to interact with it. Prefer `allowFrom` lists:

```bash
# Check current channel DM policies
openclaw doctor
openclaw security audit
```

### Per-peer session isolation

When multiple users can DM your bot, isolate their sessions:

```bash
openclaw config set session.dmScope per-channel-peer
```

This prevents context leakage between different users.

---

## Dangerous Config Flags

### `allowUnsafeExternalContent` — injection scanner bypass

Several hook types (Gmail hooks, custom hook mappings) support an
`allowUnsafeExternalContent: true` option. **Setting this flag disables the
injection scanner hard-stop for that hook source.** Incoming content from that
source will no longer be blocked for injection attempts; the agent processes
the content as if it were fully trusted.

**This is a significant security regression.** A malicious email or external
webhook payload could use prompt-injection techniques to manipulate the
agent's tool calls, exfiltrate data, or escalate privileges.

Only set this flag when:

1. The injection scanner produces too many false positives for a specific
   trusted internal source (e.g. an internal monitoring webhook with
   structured JSON payloads).
2. You have an independent security control at the source (e.g. the hook
   source is an authenticated internal service with no user-controlled input).

```yaml
# openclaw.yaml — use with care
hooks:
  gmail:
    allowUnsafeExternalContent: false # default — keep this
  mappings:
    - name: "internal-monitor"
      allowUnsafeExternalContent: false # default — keep this
```

The `openclaw security audit` command reports any hook with this flag enabled
as a security finding. The doctor health check also surfaces it.

---

## Container Sandbox

### Keep sandboxing enabled

The agent sandbox provides an additional layer of isolation for tool execution. Disable only if required for specific tool integrations:

```bash
# Verify sandbox is enabled
openclaw config get agents.defaults.sandbox.mode

# Enable if not set
openclaw config set agents.defaults.sandbox.mode all
```

### Network isolation

For the highest security posture, restrict network access from within the sandbox:

```bash
openclaw config set sandbox.docker.network none
```

---

## Monitoring & Alerting

### Review security events regularly

```bash
# Recent events (last 24h)
openclaw security monitoring events

# Critical events only
openclaw security monitoring events --severity critical

# Monitor runner status
openclaw security monitoring status
```

### Set up webhook alerting

For critical events, configure a webhook to receive real-time alerts:

```bash
openclaw config set security.alerting.minSeverity critical
openclaw config set security.alerting.webhook.enabled true
openclaw config set security.alerting.webhook.url "https://your-webhook.example.com/alert"
```

---

## Running a Security Check

Quick posture check:

```bash
openclaw security health
```

Full audit with fixes:

```bash
openclaw security audit --deep --fix
openclaw doctor --fix
```
