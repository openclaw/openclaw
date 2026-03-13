# Audit Logging

GovDOSS™ / CMMC Level 2 (CP-11) audit logging framework.

## Overview

Every security-relevant action is recorded as a structured `AuditEntry` with:

- **SOA⁴™ attribution**: Subject (who), Object (what), Action (how), timestamp (when)
- **Hash chain**: Each entry includes the SHA-256 hash of the previous entry,
  making deletions and modifications detectable
- **PII guard**: Field names matching sensitive patterns (`password`, `token`, etc.)
  are rejected at log time to prevent accidental secret capture

## Event Types

| Category       | Events                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Authentication | `auth.login`, `auth.logout`, `auth.login_failed`, `auth.mfa_success`, `auth.mfa_failed`                                         |
| Account        | `account.created`, `account.disabled`, `account.enabled`, `account.deleted`, `account.password_changed`, `account.role_changed` |
| Session        | `session.created`, `session.revoked`                                                                                            |
| Configuration  | `config.read`, `config.changed`                                                                                                 |
| Access Control | `access.denied`, `access.granted`                                                                                               |
| Gateway        | `gateway.started`, `gateway.stopped`, `gateway.restarted`                                                                       |
| Integrity      | `audit.log_queried`, `audit.integrity_verified`, `audit.integrity_failed`                                                       |

## Entry Structure

```typescript
type AuditEntry = {
  seq: number; // Monotonically increasing sequence number
  timestamp: string; // ISO-8601
  subject: string; // Who acted
  object: string; // What was acted upon
  action: AuditEventType;
  outcome: "success" | "failure" | "denied";
  detail?: Record<string, unknown>; // Optional context (no PII/secrets)
  prevHash: string; // SHA-256 of previous entry
  hash: string; // SHA-256 of this entry
};
```

## Hash Chain Integrity

The chain starts from a genesis hash of 64 zeros. Any modification to a logged
entry (or deletion of entries from the middle of the log) breaks the chain at
that point.

Run `openclaw logs verify` to check integrity at any time.

## CLI Commands

```bash
# Query audit log
openclaw logs query --subject user:alice --action auth.login --limit 20

# Export as JSON
openclaw logs query --json > audit-export.json

# Verify integrity
openclaw logs verify

# Log statistics
openclaw logs stats
```

## API

```typescript
import { AuditLogger } from "src/logging/audit-logger.js";

const logger = new AuditLogger();

// Log an event
logger.log({
  subject: "user:alice",
  object: "account:bob",
  action: "account.disabled",
  outcome: "success",
  detail: { reason: "policy violation" },
});

// Query
const denied = logger.query({ outcome: "denied", limit: 100 });

// Verify chain
const result = logger.verifyIntegrity();
```

## CMMC Controls Addressed

- **CP-11.1**: Audit record generation for security-relevant events
- **CP-11.2**: Audit record content (subject, object, action, outcome, timestamp)
- **CP-11.3**: Audit record storage capacity and protection
- **CP-11.4**: Audit record review and reporting
