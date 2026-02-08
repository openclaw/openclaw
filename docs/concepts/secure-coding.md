---
summary: "Secure coding guidelines for AI-generated code"
read_when:
  - Configuring security settings
  - Understanding code generation safeguards
title: "Secure Coding Guidelines"
---

# Secure Coding Guidelines

OpenClaw includes built-in security guidelines for AI-generated code. When the agent writes or modifies code, these guidelines are included in the system prompt to encourage secure coding practices.

## When Guidelines Apply

The secure coding section is included when:

1. **Coding tools are available** (write, edit, exec, or apply_patch)
2. **Full prompt mode** is active (not minimal/subagent mode)
3. **Not explicitly disabled** via config

Note: Subagents in minimal mode do not receive these guidelines. If you need secure coding guidance for subagents, consider passing it via task prompts.

## What's Covered

The guidelines cover key areas from the OWASP Top 10 and common vulnerability patterns:

### Credentials & Secrets

- Never hardcode API keys, tokens, or passwords
- Use secret managers in production; .env only for local development
- Ensure .env files are in .gitignore
- Set proper file permissions (0600 where OS supports it)

### Input Validation & Injection Prevention

- Validate and sanitize all user inputs
- Use parameterized queries for SQL
- Escape output to prevent XSS
- Avoid shell command construction from user input
- Use safe APIs; when exec is necessary, escape/quote properly

### Authentication & Access Control

- Implement proper auth checks on protected endpoints
- Use established auth libraries (don't roll your own)
- Check authorization for every resource (prevent IDOR)
- Use secure session management
- Implement CSRF protection

### Cryptography

- Use established crypto libraries
- Use strong algorithms (AES-256-GCM, bcrypt/argon2)
- Generate cryptographically secure random values
- Never use MD5 or SHA1 for security

### Dependencies

- Use lockfiles for reproducible builds
- Run security audits before committing
- Keep dependencies updated (pinning without updates freezes vulnerabilities)

### File & Network Operations

- Validate file paths (prevent path traversal)
- Validate URLs (prevent SSRF)
- Validate file uploads (type, size, filename)
- Use restrictive permissions

### Error Handling & Logging

- Never expose stack traces to end users
- Log security events for monitoring
- Never log sensitive data
- Fail securely (deny by default)

### Pre-Commit Checks

- Review diffs for secret exposure
- Remove debug code and backdoors
- Verify tests pass

## Configuration

Secure coding guidelines are **enabled by default** when coding tools are available.

To explicitly disable (note: OpenClaw config uses JSON5 syntax, which allows unquoted keys and trailing commas):

```json5
{
  agents: {
    defaults: {
      secureCodingGuidelines: false,
    },
  },
}
```

Or in strict JSON:

```json
{
  "agents": {
    "defaults": {
      "secureCodingGuidelines": false
    }
  }
}
```

## Best Practices

Even with guidelines enabled, consider:

1. **Code Review**: Review AI-generated code before deployment
2. **Security Scanning**: Use automated tools like `npm audit`, `trivy`, or `detect-secrets`
3. **Least Privilege**: Limit agent permissions where possible
4. **Sandboxing**: Run untrusted code in sandboxed environments

## Limitations

- Guidelines only appear in **full prompt mode** (not minimal/subagent)
- Guidelines require **coding tools** to be available
- Guidelines are **reminders**, not enforcement — the agent may still make mistakes

## See Also

- [Security](/gateway/security/) — Security overview and formal verification
- [Sandboxing](/gateway/sandboxing) — Sandboxed code execution
- [Agent Concepts](/concepts/agent) — Tool policies and agent configuration
