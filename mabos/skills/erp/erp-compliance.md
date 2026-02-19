# ERP Compliance Tools

## Tool: `erp_compliance`

Manage compliance policies and track violations. Ensure organizational adherence to regulatory and internal standards.

## Actions

### `create_policy`

Create a new compliance policy.

**Parameters:**

- `title` (required) - Policy title
- `category` (required) - Policy category (data_privacy, financial, safety, hr, environmental)
- `version` (optional) - Version string (e.g., "1.0")
- `content` (optional) - Policy body text or summary
- `effective_date` (optional) - When the policy takes effect (ISO 8601)

**Example:**

```json
{
  "action": "create_policy",
  "params": {
    "title": "Data Retention Policy",
    "category": "data_privacy",
    "version": "2.0",
    "content": "All PII must be purged after 24 months of inactivity.",
    "effective_date": "2026-03-01"
  }
}
```

### `get_policy`

Retrieve a policy by ID.

**Parameters:**

- `id` (required) - Policy ID

### `list_policies`

List policies with optional filters.

**Parameters:**

- `status` (optional) - Filter by status (draft, active, retired)
- `category` (optional) - Filter by category
- `limit` (optional) - Max results

### `update_policy`

Update policy fields.

**Parameters:**

- `id` (required) - Policy ID
- Additional fields to update (title, content, version, status)

### `report_violation`

Report a compliance violation.

**Parameters:**

- `severity` (required) - Severity level (low, medium, high, critical)
- `description` (required) - What happened
- `policy_id` (optional) - Which policy was violated
- `reported_by` (optional) - Reporter identifier

**Example:**

```json
{
  "action": "report_violation",
  "params": {
    "severity": "high",
    "description": "Customer data exported without encryption",
    "policy_id": "pol_005",
    "reported_by": "agent_audit"
  }
}
```

### `get_violation`

Retrieve a violation by ID.

**Parameters:**

- `id` (required) - Violation ID

### `list_violations`

List violations with optional filters.

**Parameters:**

- `status` (optional) - Filter by status (open, investigating, resolved, dismissed)
- `severity` (optional) - Filter by severity
- `policy_id` (optional) - Filter by related policy
- `limit` (optional) - Max results

### `resolve_violation`

Mark a violation as resolved with a resolution note.

**Parameters:**

- `id` (required) - Violation ID
- `resolution` (required) - How the violation was resolved

**Example:**

```json
{
  "action": "resolve_violation",
  "params": {
    "id": "vio_008",
    "resolution": "Encryption enforced on all export endpoints. Staff retrained."
  }
}
```

## Tips

- Link violations to policies so audit trails are complete.
- Version your policies — never edit in place; create a new version instead.
- Prioritize critical and high severity violations for immediate resolution.
- Review retired policies periodically to ensure replacements are in effect.
