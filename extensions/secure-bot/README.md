# @openclaw/secure-bot

Security-hardened AI bot extension with enhanced protection features for OpenClaw.

## Features

- **Input Validation**: Automatic sanitization and length limiting
- **Rate Limiting**: Configurable request throttling per user
- **Prompt Injection Detection**: Pattern-based detection and blocking
- **Access Control**: Allowlist/blocklist with admin bypass
- **Audit Logging**: Security event tracking with redaction
- **Sensitive Data Redaction**: Automatic PII/credential masking

## Installation

```bash
openclaw plugins install @openclaw/secure-bot
```

## Configuration

Add to your `~/.openclaw/config.yml`:

```yaml
plugins:
  entries:
    secure-bot:
      enabled: true
      security:
        inputValidation: true
        maxInputLength: 10000
        detectPromptInjection: true
        blockInjectionAttempts: true
        rateLimiting:
          enabled: true
          windowMs: 60000
          maxRequests: 30
        auditLogging: true
      access:
        defaultPolicy: allow
        allowlist: []
        blocklist: []
        admins:
          - "admin-user-id"
```

## Security Features

### Prompt Injection Detection

Detects and blocks common injection patterns:
- Instruction override attempts ("ignore previous instructions")
- Role manipulation ("you are now...")
- System prompt extraction attempts
- Jailbreak patterns
- Code injection markers

### Rate Limiting

Protects against abuse with configurable limits:
- Per-user request counting
- Configurable time windows
- Admin bypass capability

### Access Control

Fine-grained access management:
- Default allow/deny policies
- User allowlist and blocklist
- Admin users with elevated privileges

### Audit Logging

Comprehensive security event tracking:
- Message received/blocked events
- Injection detection events
- Rate limit violations
- Access denials

## API

```typescript
import { securityEngine } from '@openclaw/secure-bot';

// Check security metrics
const metrics = securityEngine.getMetrics();

// Get recent security events
const events = securityEngine.getRecentEvents(100);

// Clear rate limit for a user
securityEngine.clearRateLimit('user-id');
```

## License

MIT
