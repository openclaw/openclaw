# ERP Suppliers Tools

## Tool: `erp_suppliers`

Manage supplier relationships and purchase orders. Track vendor terms, order fulfillment, and receiving workflows.

## Actions

### `create_supplier`

Register a new supplier.

**Parameters:**

- `name` (required) - Supplier name
- `contact_email` (optional) - Primary contact email
- `category` (optional) - Supplier category (e.g., raw_materials, services)
- `terms` (optional) - Payment terms (e.g., "net30")

**Example:**

```json
{
  "action": "create_supplier",
  "params": {
    "name": "Global Parts Inc.",
    "contact_email": "sales@globalparts.com",
    "category": "raw_materials",
    "terms": "net30"
  }
}
```

### `get_supplier`

Retrieve a supplier by ID.

**Parameters:**

- `id` (required) - Supplier ID

### `list_suppliers`

List suppliers with optional filters.

**Parameters:**

- `status` (optional) - Filter by status (active, inactive)
- `category` (optional) - Filter by category
- `limit` (optional) - Max results

### `update_supplier`

Update supplier fields.

**Parameters:**

- `id` (required) - Supplier ID
- Additional fields to update (name, contact_email, category, terms, status)

### `create_po`

Create a purchase order for a supplier.

**Parameters:**

- `supplier_id` (required) - Supplier to order from
- `items` (required) - Array of {description, quantity, unit_cost}
- `expected_delivery` (optional) - Expected delivery date (ISO 8601)

**Example:**

```json
{
  "action": "create_po",
  "params": {
    "supplier_id": "sup_003",
    "items": [{ "description": "Steel bolts M8", "quantity": 5000, "unit_cost": 0.12 }],
    "expected_delivery": "2026-03-10"
  }
}
```

### `get_po`

Retrieve a purchase order by ID.

**Parameters:**

- `id` (required) - Purchase order ID

### `list_pos`

List purchase orders with optional filters.

**Parameters:**

- `supplier_id` (optional) - Filter by supplier
- `status` (optional) - Filter by status (draft, sent, received, cancelled)
- `limit` (optional) - Max results

### `receive_po`

Mark a purchase order as received, updating inventory.

**Parameters:**

- `id` (required) - Purchase order ID

**Example:**

```json
{ "action": "receive_po", "params": { "id": "po_017" } }
```

## Tips

- Use `receive_po` when goods arrive — this triggers inventory updates automatically.
- Track payment terms per supplier to coordinate with `erp_finance` for timely payments.
- Review supplier categories to consolidate vendors and negotiate better rates.
- Always set `expected_delivery` on POs so supply chain agents can plan accordingly.
