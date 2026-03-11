---
title: "Security Best Practices"
summary: "Practical security hardening guide for OpenClaw deployments"
read_when:
  - Setting up a new OpenClaw instance
  - Hardening an existing deployment
  - Reviewing security posture
  - Onboarding users to a shared instance
---

# Security Best Practices

This guide provides practical security recommendations for OpenClaw deployments. For the formal threat model, see [MITRE ATLAS Threat Model](/security/THREAT-MODEL-ATLAS).

## Initial Setup Hardening

### Token and Secret Management

**Use `openclaw secrets` for all sensitive values:**

```bash
# Store API keys as secrets (encrypted at rest)
openclaw secrets set OPENAI_API_KEY sk-...
openclaw secrets set ANTHROPIC_API_KEY sk-ant-...

# Never put secrets in openclaw.json or environment files
```

**Token rotation schedule:**

| Token Type | Rotation Frequency | Notes |
|-----------|-------------------|-------|
| LLM API keys | Every 90 days | Set calendar reminders |
| GitHub PATs | Every 60 days | Use fine-grained tokens with minimal scopes |
| Channel tokens (Telegram, Discord) | On compromise only | Regenerate immediately if exposed |
| Webhook secrets | Every 90 days | Update both sides atomically |

**Minimal scope principle:** When creating tokens (GitHub, Slack, etc.), grant only the permissions your agent actually needs. Avoid "full access" tokens.

### AllowList Configuration

Restrict which tools and commands your agent can use:

```json5
// openclaw.json
{
  tools: {
    // Explicit deny list for dangerous tools
    deny: ["dangerous_tool_name"],

    // Restrict exec to safe binaries
    exec: {
      security: "allowlist",
      allowedBinaries: ["grep", "cat", "ls", "find", "git"]
    }
  }
}
```

### Network Security

```json5
{
  // Restrict outbound fetch
  fetch: {
    allowedDomains: ["api.openai.com", "api.anthropic.com"],
    blockPrivateIPs: true,  // Prevents SSRF attacks
    maxRedirects: 3
  }
}
```

## Multi-User Security

### Agent Isolation

When multiple users interact with the same OpenClaw instance:

1. **Session isolation:** Each user gets separate session context. Never leak session data cross-user.
2. **Memory boundaries:** `MEMORY.md` loads only in private/owner sessions — never in group chats.
3. **Tool permissions:** Consider per-user tool restrictions for shared deployments.

### Group Chat Information Boundaries

```
✅ Safe in group chats:
- General knowledge responses
- Public information summaries
- Shared project context

❌ Never expose in group chats:
- Private calendar details ("has an interview at 3pm")
- Personal messages from other chats
- File contents from private drives
- API keys, tokens, or credentials (not even to the owner)
```

### Owner Verification

Always verify sender identity before performing privileged operations:

```
1. Extract sender_id from message metadata
2. Compare against configured owner open_id
3. Check chat_type (direct vs group)
4. Apply appropriate permission level
```

## Operational Security

### Logging Hygiene

**What gets logged (and shouldn't contain secrets):**
- Session transcripts (tool calls and responses)
- Agent workspace file changes
- Gateway request/response metadata

**Best practices:**
- Review logs periodically for accidental secret exposure
- Set up log rotation to limit retention
- Never log full API responses containing user PII

### Backup and Recovery

```bash
# Backup workspace (includes memory, config, skills)
tar -czf openclaw-backup-$(date +%Y%m%d).tar.gz \
  --exclude='node_modules' \
  --exclude='.git' \
  /path/to/agent/workspace

# Encrypt backups containing secrets
gpg -c openclaw-backup-*.tar.gz
```

### Update Policy

Keep OpenClaw updated for security patches:

```bash
# Check current version
openclaw --version

# Update to latest
npm update -g openclaw

# Review changelog for security fixes
# https://github.com/openclaw/openclaw/releases
```

## Common Security Pitfalls

### 1. Exposing Tokens in Group Chats

**Problem:** Sending API keys or tokens in group conversations where others can see them.

**Fix:** Always share sensitive information through direct messages only. If accidentally exposed, rotate the token immediately.

### 2. Over-Permissive Tool Policies

**Problem:** Using `security: "full"` for exec, allowing arbitrary command execution.

**Fix:** Use allowlist mode and explicitly enumerate safe binaries:

```json5
{
  tools: {
    exec: {
      security: "allowlist",  // not "full"
      allowedBinaries: ["grep", "cat", "ls", "node"]
    }
  }
}
```

### 3. Unprotected Webhook Endpoints

**Problem:** Webhook URLs without authentication, allowing anyone to trigger agent actions.

**Fix:** Always configure webhook secrets and validate signatures:

```json5
{
  channels: {
    telegram: {
      webhookSecret: "${TELEGRAM_WEBHOOK_SECRET}"  // Use secrets
    }
  }
}
```

### 4. Memory Leakage Across Contexts

**Problem:** Private information from MEMORY.md appearing in group chat responses.

**Fix:** Follow the memory loading rules:
- ✅ Load MEMORY.md in direct/owner sessions only
- ❌ Never load in group chats or shared sessions
- Implement explicit checks in AGENTS.md

### 5. Prompt Injection via Untrusted Input

**Problem:** Malicious users crafting messages that manipulate agent behavior.

**Fix:**
- Treat all user input as untrusted
- Use structured tool calls instead of string interpolation
- Implement input validation for critical operations
- Mark metadata as "untrusted" in system prompts

### 6. SSRF Through Fetch Tools

**Problem:** Agent fetching internal network resources via user-controlled URLs.

**Fix:** Enable private IP blocking in fetch configuration:

```json5
{
  fetch: {
    blockPrivateIPs: true,  // Blocks 10.x, 172.16-31.x, 192.168.x
    blockLocalhost: true,
    maxRedirects: 3  // Limit redirect chains
  }
}
```

## Security Checklist

Use this checklist when setting up or auditing an OpenClaw deployment:

- [ ] All API keys stored via `openclaw secrets` (not in config files)
- [ ] Token rotation schedule established
- [ ] Exec tool using allowlist mode (not "full")
- [ ] Fetch domains restricted or private IPs blocked
- [ ] MEMORY.md loading restricted to private sessions
- [ ] Group chat information boundaries documented in AGENTS.md
- [ ] Webhook endpoints use authentication
- [ ] Backups encrypted and stored securely
- [ ] Log rotation configured
- [ ] OpenClaw version is current
- [ ] Owner verification logic in place for privileged operations

## Reporting Security Issues

If you discover a security vulnerability in OpenClaw:

1. **Do not** open a public GitHub issue
2. Follow the [security policy](https://github.com/openclaw/openclaw/security/policy)
3. Include: steps to reproduce, impact assessment, suggested fix

## Further Reading

- [MITRE ATLAS Threat Model](/security/THREAT-MODEL-ATLAS)
- [Contributing to Threat Model](/security/CONTRIBUTING-THREAT-MODEL)
- [Tool Security Configuration](/reference/configuration)
- [Session Management](/reference/session-management-compaction)
