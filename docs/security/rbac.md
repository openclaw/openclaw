# RBAC — Role-Based Access Control

GovDOSS™ / CMMC Level 2 (CP-1) access control framework.

## Role Hierarchy

| Role       | Rank | Description                                              |
| ---------- | ---- | -------------------------------------------------------- |
| `admin`    | 3    | Full control — account lifecycle, gateway ops, all reads |
| `operator` | 2    | Manage sessions, config writes, audit exports            |
| `observer` | 1    | Read-only access to accounts, config, audit log          |
| `guest`    | 0    | Gateway status and channel reads only (default)          |

Unknown or unparsed roles default to `guest` (fail-safe principle).

## Permission Catalogue

| Permission        | admin | operator | observer | guest |
| ----------------- | ----- | -------- | -------- | ----- |
| `account:create`  | ✅    | ❌       | ❌       | ❌    |
| `account:disable` | ✅    | ❌       | ❌       | ❌    |
| `account:enable`  | ✅    | ❌       | ❌       | ❌    |
| `account:delete`  | ✅    | ❌       | ❌       | ❌    |
| `account:list`    | ✅    | ✅       | ✅       | ❌    |
| `session:revoke`  | ✅    | ✅       | ❌       | ❌    |
| `session:list`    | ✅    | ✅       | ✅       | ❌    |
| `config:read`     | ✅    | ✅       | ✅       | ❌    |
| `config:write`    | ✅    | ✅       | ❌       | ❌    |
| `audit:read`      | ✅    | ✅       | ✅       | ❌    |
| `audit:export`    | ✅    | ✅       | ❌       | ❌    |
| `gateway:restart` | ✅    | ❌       | ❌       | ❌    |
| `gateway:status`  | ✅    | ✅       | ✅       | ✅    |
| `channel:read`    | ✅    | ✅       | ✅       | ✅    |
| `channel:write`   | ✅    | ✅       | ❌       | ❌    |

## Usage

```typescript
import { createAccessController } from "src/gateway/access-control/access-controller.js";

// Parse role from untrusted source (defaults to 'guest' if unknown)
const ac = createAccessController(requestRole);

// Check — returns typed result
const result = ac.check("config:write");
if (!result.ok) {
  return respondForbidden(result.reason);
}

// Assert — throws AccessDeniedError on failure (use in internal paths)
ac.assert("account:create");
```

## Design Principles

- **Fail-safe**: unknown roles default to `guest` (minimum privilege)
- **Explicit**: no implicit inheritance — permissions are enumerated per role
- **Pure functions**: role parsing and permission checks have no side effects
- **Auditable**: `AccessController.role` is always available for audit logging
