# ERP Legal Tools

## Tool: `erp_legal`

Manage contracts, legal cases, and compliance-related legal matters. Track contract lifecycles, deadlines, and case resolutions.

## Actions

### `create_contract`

Create a new contract record.

**Parameters:**

- `title` (required) - Contract title
- `counterparty` (required) - Other party name
- `type` (required) - Contract type (vendor, client, employment, nda, partnership)
- `value` (optional) - Contract monetary value
- `start_date` (optional) - Start date (ISO 8601)
- `end_date` (optional) - End date (ISO 8601)
- `terms` (optional) - Key terms summary

**Example:**

```json
{
  "action": "create_contract",
  "params": {
    "title": "Cloud Services Agreement",
    "counterparty": "AWS",
    "type": "vendor",
    "value": 120000,
    "start_date": "2026-01-01",
    "end_date": "2027-01-01",
    "terms": "Annual commitment, auto-renew"
  }
}
```

### `get_contract`

Retrieve a contract by ID.

**Parameters:**

- `id` (required) - Contract ID

### `list_contracts`

List contracts with optional filters.

**Parameters:**

- `status` (optional) - Filter by status (draft, active, expired, terminated)
- `counterparty` (optional) - Filter by counterparty
- `type` (optional) - Filter by contract type
- `limit` (optional) - Max results

### `update_contract`

Update contract fields.

**Parameters:**

- `id` (required) - Contract ID
- Additional fields to update (title, status, value, end_date, terms)

### `expiring_contracts`

Find contracts expiring within a given window.

**Parameters:**

- `within_days` (required) - Number of days to look ahead

**Example:**

```json
{ "action": "expiring_contracts", "params": { "within_days": 30 } }
```

### `create_case`

Open a new legal case.

**Parameters:**

- `title` (required) - Case title
- `case_type` (required) - Type (dispute, litigation, regulatory, ip)
- `priority` (required) - Priority level (low, medium, high, critical)
- `description` (optional) - Case details
- `assigned_to` (optional) - Assigned attorney or team

### `get_case`

Retrieve a legal case by ID.

**Parameters:**

- `id` (required) - Case ID

### `list_cases`

List legal cases with optional filters.

**Parameters:**

- `status` (optional) - Filter by status (open, in_review, resolved, closed)
- `case_type` (optional) - Filter by type
- `limit` (optional) - Max results

### `update_case`

Update case fields.

**Parameters:**

- `id` (required) - Case ID
- Additional fields to update (status, priority, assigned_to, description)

## Tips

- Run `expiring_contracts` weekly to catch renewals before they lapse.
- Always record contract value for accurate financial forecasting with `erp_finance`.
- Use case priority to triage legal workload effectively.
- Keep terms summaries concise — link to full documents externally if needed.
