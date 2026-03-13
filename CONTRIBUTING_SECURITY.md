# Security Contribution Guidelines

## GovDOSS™ Principles for Contributors

All security-related contributions must adhere to the following principles:

- **Governance**: every action must be auditable and traceable (SOA⁴™)
- **Defensive**: secure-by-default with fail-safe mechanisms
- **Offensive**: automated controls that don't impede legitimate operations
- **Simple (KIS⁴™)**: minimal dependencies, clear code structure

## Pre-Commit Checks

This repository uses `prek` (pre-commit) hooks. Install with:

```bash
prek install
```

Hooks include:

- `detect-secrets` — scans for hardcoded credentials
- `detect-private-key` — blocks private key commits
- `oxlint` / `oxfmt` — TypeScript lint and format
- `actionlint` / `zizmor` — GitHub Actions security audit

## Secrets Management

- **Never** hardcode credentials, tokens, API keys, or passwords in source code
- Use environment variables or the OpenClaw secrets system (`openclaw secrets`)
- Run `detect-secrets scan` before committing new files
- Update `.secrets.baseline` when adding intentional test fixtures:
  ```bash
  detect-secrets scan --baseline .secrets.baseline
  ```

## RBAC Guidelines

When adding new functionality that requires authorization:

1. Define a new `Permission` entry in `src/gateway/access-control/rbac.ts`
2. Assign the permission to appropriate roles in `ROLE_PERMISSIONS`
3. Enforce via `AccessController.assert()` at the entry point
4. Add audit log events for the action

## Audit Logging Guidelines

All security-relevant actions must be logged via `AuditLogger`:

- Log before and after mutating state when possible
- Use `outcome: "failure"` for expected errors; `"denied"` for access denials
- Never include raw secrets, passwords, or tokens in `detail`
- Follow SOA⁴™: subject (who), object (what), action (how)

```typescript
logger.log({
  subject: `user:${actor.username}`,
  object: `account:${targetId}`,
  action: "account.disabled",
  outcome: "success",
  detail: { reason: "policy violation" },
});
```

## Password Handling

- Use `hashPassword` from `src/gateway/auth/password-policy.ts` — never roll your own
- Never log passwords, hashes, or salts
- Always use `verifyPassword` (timing-safe) for comparisons
- Enforce `validatePasswordStrength` on all user-facing password inputs

## Security Review Requirements

PRs that touch any of the following require an explicit security review:

- `src/gateway/access-control/` — RBAC framework
- `src/gateway/accounts/` — Account management
- `src/gateway/auth/` — Authentication and password policy
- `src/logging/audit-logger.ts` — Audit chain
- `.github/workflows/` — CI/CD pipeline
- `SECURITY.md` — Security policy

## Vulnerability Reporting

See [SECURITY.md](../SECURITY.md) for the full vulnerability reporting process.
