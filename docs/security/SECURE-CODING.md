---
title: "Secure Coding Guidelines"
summary: "Security coding standards for OpenClaw contributors"
read_when:
  - Contributing code to OpenClaw
  - Reviewing pull requests for security issues
  - Understanding OpenClaw's security architecture
---

# Secure Coding Guidelines

This document defines security coding standards for OpenClaw contributors. All code contributions should follow these guidelines.

## Command Execution

**Always use the `exec-safe` module for command execution.**

```typescript
// ✅ Good: Uses exec-safe with allowlist
import { execSafe } from './exec-safe';
await execSafe(command, { security: 'allowlist' });

// ❌ Bad: Direct child_process usage
import { exec } from 'child_process';
exec(userInput); // Command injection risk
```

**Rules:**
- Never pass unsanitized user input to shell commands
- Use the allowlist security mode by default
- Log all command executions for audit trail

## Credential Management

**Never hardcode credentials. Use SecretRefs.**

```json5
// ✅ Good: SecretRef
{
  "apiKey": { "$ref": "secrets:OPENAI_API_KEY" }
}

// ❌ Bad: Hardcoded
{
  "apiKey": "sk-abc123..."
}
```

**Rules:**
- Store all secrets via `openclaw secrets`
- Rotate credentials on schedule (see [Security Best Practices](/security/best-practices))
- Never log API keys, tokens, or passwords

## Input Validation

**Validate all external input with schema-based validation.**

```typescript
// ✅ Good: Schema validation
const schema = z.object({
  url: z.string().url(),
  timeout: z.number().min(0).max(300),
});
const parsed = schema.parse(userInput);

// ❌ Bad: Trust user input
const url = userInput.url; // No validation
```

**Rules:**
- Treat all user messages as untrusted
- Validate URLs before fetch (block private IPs for SSRF prevention)
- Sanitize file paths to prevent directory traversal

## Log Hygiene

**Never log sensitive data.**

```typescript
// ✅ Good: Redacted logging
log.info('Auth request', { provider: config.provider, status: 'ok' });

// ❌ Bad: Leaking secrets
log.info('Auth request', { token: config.apiKey }); // Key in logs!
```

**Sensitive patterns to redact:**
- API keys and tokens (`sk-*`, `ghp_*`, `xoxb-*`)
- Passwords and secrets
- Personal identifiable information (PII)
- OAuth authorization codes

## Security Review Checklist

Use this checklist when reviewing PRs:

- [ ] No direct `child_process.exec()` or `child_process.spawn()` calls (use `exec-safe`)
- [ ] No hardcoded API keys, tokens, or passwords
- [ ] All external input validated before use
- [ ] No sensitive data in log statements
- [ ] URLs validated before fetch (SSRF check)
- [ ] File paths sanitized (no traversal)
- [ ] Error messages don't leak internal details
- [ ] Authentication checks on privileged operations

## Trust Boundaries

```
┌─────────────────────────────────────────┐
│              User Input                  │ ← UNTRUSTED
├─────────────────────────────────────────┤
│         Input Validation Layer           │ ← Sanitize here
├─────────────────────────────────────────┤
│    Tool Execution (exec-safe, fetch)     │ ← Allowlist enforcement
├─────────────────────────────────────────┤
│      Core Logic (agents, memory)         │ ← Trusted zone
├─────────────────────────────────────────┤
│    Output Layer (channels, logs)         │ ← Redact here
└─────────────────────────────────────────┘
```

## Reporting Vulnerabilities

See [Security Policy](https://github.com/openclaw/openclaw/security/policy).

## Further Reading

- [Security Best Practices](/security/best-practices)
- [MITRE ATLAS Threat Model](/security/THREAT-MODEL-ATLAS)
- [Contributing to Threat Model](/security/CONTRIBUTING-THREAT-MODEL)
