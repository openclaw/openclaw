# MeshGuard API Reference

Base URL: `{MESHGUARD_URL}/api/v1`

All authenticated endpoints require: `Authorization: Bearer <API_KEY>`

Admin endpoints require: `Authorization: Bearer <ADMIN_TOKEN>`

---

## Health

### `GET /health`
Check gateway health. No auth required.

**Response:**
```json
{
  "status": "healthy",
  "version": "1.4.2",
  "uptime_seconds": 86400,
  "services": {
    "database": "connected",
    "cache": "connected",
    "queue": "connected"
  }
}
```

---

## Agents

### `GET /agents`
List all agents in the organization.

**Response:**
```json
{
  "agents": [
    {
      "id": "ag_abc123",
      "name": "my-agent",
      "tier": "pro",
      "status": "active",
      "created_at": "2025-01-15T10:00:00Z",
      "policies": ["pol_xyz789"]
    }
  ],
  "total": 1
}
```

### `POST /agents`
Create a new agent.

**Body:**
```json
{
  "name": "my-agent",
  "tier": "free|pro|enterprise"
}
```

**Response:** Agent object with `id`, `api_key`.

### `GET /agents/{id}`
Get agent details by ID.

### `DELETE /agents/{id}`
Delete an agent. Returns `204 No Content`.

---

## Policies

### `GET /policies`
List all policies.

**Response:**
```json
{
  "policies": [
    {
      "id": "pol_xyz789",
      "name": "rate-limit-policy",
      "description": "Limit agent calls to 100/min",
      "rules": [
        {
          "type": "rate_limit",
          "max_requests": 100,
          "window_seconds": 60
        }
      ],
      "created_at": "2025-01-15T10:00:00Z"
    }
  ],
  "total": 1
}
```

### `POST /policies`
Create a new policy.

**Body:**
```json
{
  "name": "my-policy",
  "description": "Policy description",
  "rules": [
    {
      "type": "rate_limit",
      "max_requests": 100,
      "window_seconds": 60
    },
    {
      "type": "content_filter",
      "block_categories": ["pii", "credentials"]
    },
    {
      "type": "scope_restriction",
      "allowed_actions": ["read", "search"],
      "denied_actions": ["delete", "admin"]
    }
  ]
}
```

### Rule Types

| Type | Fields | Description |
|------|--------|-------------|
| `rate_limit` | `max_requests`, `window_seconds` | Throttle request rate |
| `content_filter` | `block_categories` | Block sensitive content categories |
| `scope_restriction` | `allowed_actions`, `denied_actions` | Restrict agent capabilities |
| `time_window` | `allowed_hours`, `timezone` | Restrict operation hours |
| `budget_limit` | `max_cost_usd`, `period` | Cost guardrails |

### `GET /policies/{id}`
Get policy details.

### `DELETE /policies/{id}`
Delete a policy. Returns `204 No Content`.

---

## Audit Logs

### `GET /audit/logs`
Query audit events.

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `agent` | string | Filter by agent name |
| `action` | string | Filter by action type |
| `limit` | integer | Max results (default: 20, max: 1000) |
| `offset` | integer | Pagination offset |
| `from` | ISO 8601 | Start timestamp |
| `to` | ISO 8601 | End timestamp |

**Actions:** `agent.create`, `agent.delete`, `agent.update`, `policy.create`, `policy.update`, `policy.delete`, `policy.attach`, `policy.detach`, `auth.login`, `auth.revoke`, `violation.rate_limit`, `violation.content_filter`, `violation.scope`

**Response:**
```json
{
  "events": [
    {
      "id": "evt_001",
      "timestamp": "2025-01-15T10:30:00Z",
      "action": "agent.create",
      "agent": "my-agent",
      "actor": "user@example.com",
      "details": {
        "tier": "pro"
      },
      "ip": "192.168.1.1"
    }
  ],
  "total": 42,
  "limit": 20,
  "offset": 0
}
```

---

## Organization Signup

### `POST /orgs/signup` *(Admin token required)*
Create a new organization.

**Body:**
```json
{
  "name": "Acme Corp",
  "email": "admin@acme.com"
}
```

**Response:**
```json
{
  "org_id": "org_abc123",
  "name": "Acme Corp",
  "api_key": "mg_live_...",
  "admin_token": "mg_admin_...",
  "dashboard_url": "https://dashboard.meshguard.app/org/org_abc123"
}
```

---

## Error Responses

All errors follow this format:
```json
{
  "error": {
    "code": "unauthorized",
    "message": "Invalid or expired API key",
    "status": 401
  }
}
```

Common error codes: `unauthorized` (401), `forbidden` (403), `not_found` (404), `rate_limited` (429), `internal_error` (500).
