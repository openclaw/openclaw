# ERP Customers Tools

## Tool: `erp_customers`

Manage CRM contacts, interactions, and customer lifecycle. Track leads, active customers, and churned accounts with full interaction history.

## Actions

### `create`

Create a new customer contact.

**Parameters:**

- `name` (required) - Full name of the contact
- `email` (optional) - Email address
- `phone` (optional) - Phone number
- `company` (optional) - Company or organization name
- `tags` (optional) - Array of tags for segmentation

**Example:**

```json
{
  "action": "create",
  "params": {
    "name": "Jane Smith",
    "email": "jane@acme.co",
    "company": "Acme Corp",
    "tags": ["enterprise", "lead"]
  }
}
```

### `get`

Retrieve a customer by ID.

**Parameters:**

- `id` (required) - Customer ID

### `list`

List customers with optional filters.

**Parameters:**

- `status` (optional) - Filter by status (active, lead, churned)
- `limit` (optional) - Max results to return

### `search`

Search customers by keyword across name, email, company.

**Parameters:**

- `query` (required) - Search term

**Example:**

```json
{ "action": "search", "params": { "query": "acme" } }
```

### `update`

Update customer fields.

**Parameters:**

- `id` (required) - Customer ID
- Additional fields to update (name, email, phone, company, tags, status)

### `delete`

Remove a customer record.

**Parameters:**

- `id` (required) - Customer ID

### `log_interaction`

Log a customer interaction (call, email, meeting, etc.).

**Parameters:**

- `contact_id` (required) - Customer ID
- `type` (required) - Interaction type (call, email, meeting, note)
- `notes` (optional) - Interaction details

**Example:**

```json
{
  "action": "log_interaction",
  "params": {
    "contact_id": "cust_001",
    "type": "call",
    "notes": "Discussed renewal options for Q3"
  }
}
```

## Tips

- Use tags consistently for segmentation — agree on a tag taxonomy early.
- Log every meaningful interaction so other agents have full context.
- Search before creating to avoid duplicate contacts.
- Use status filters to focus on active leads vs. churned accounts.
