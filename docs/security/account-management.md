# Account Management

GovDOSS™ / CMMC Level 2 (CP-2) account lifecycle controls.

## Account Lifecycle

```
                  ┌──────────┐
   create ───────▶│  active  │
                  └────┬─────┘
                       │ disable
                  ┌────▼─────┐
                  │ disabled │
                  └────┬─────┘
                       │ enable
                       ▼
                  (back to active)
```

Accounts in `disabled` state cannot authenticate. Sessions for disabled accounts
are revoked at disable time (caller responsibility via `session:revoke`).

## Account Fields

| Field        | Description                                 |
| ------------ | ------------------------------------------- |
| `id`         | Immutable UUID                              |
| `username`   | Unique login name                           |
| `role`       | RBAC role (see [RBAC docs](/security/rbac)) |
| `status`     | `active` \| `disabled` \| `locked`          |
| `createdAt`  | ISO-8601 creation timestamp                 |
| `updatedAt`  | ISO-8601 last-modification timestamp        |
| `disabledAt` | ISO-8601 disable timestamp (null if active) |
| `createdBy`  | Subject who created the account             |
| `updatedBy`  | Subject who last modified the account       |
| `requireMfa` | MFA flag (defaults to `true`)               |

## CLI Commands

```bash
# Create account (requires admin role)
OPENCLAW_ACTOR_ROLE=admin openclaw account create alice --role operator

# List accounts
OPENCLAW_ACTOR_ROLE=observer openclaw account list

# Disable account
OPENCLAW_ACTOR_ROLE=admin openclaw account disable <id>

# Re-enable account
OPENCLAW_ACTOR_ROLE=admin openclaw account enable <id>

# Delete account permanently
OPENCLAW_ACTOR_ROLE=admin openclaw account delete <id>
```

## Environment Variables

| Variable                    | Description                             |
| --------------------------- | --------------------------------------- |
| `OPENCLAW_ACTOR_ROLE`       | Role used for CLI operations (required) |
| `OPENCLAW_ACTOR_SUBJECT`    | Subject label for audit trail           |
| `OPENCLAW_ACCOUNT_PASSWORD` | Non-interactive password input          |

## CMMC Controls Addressed

- **CP-2.1**: Account creation with role assignment
- **CP-2.2**: Account modification with audit trail
- **CP-2.3**: Account disable/termination
- **CP-2.4**: Account listing and review
