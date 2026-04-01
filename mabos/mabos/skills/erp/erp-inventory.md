# ERP Inventory Tools

## Tool: `erp_inventory`

Manage stock items, inventory movements, and low-stock alerts. Supports multi-warehouse tracking with reorder point monitoring.

## Actions

### `create_item`

Add a new stock item to inventory.

**Parameters:**

- `sku` (required) - Unique stock-keeping unit
- `name` (required) - Item name
- `quantity` (optional) - Initial quantity on hand
- `reorder_point` (optional) - Quantity threshold that triggers low-stock alert
- `warehouse_id` (optional) - Warehouse location
- `unit` (optional) - Unit of measure (e.g., "pcs", "kg", "liters")

**Example:**

```json
{
  "action": "create_item",
  "params": {
    "sku": "BOLT-M8-SS",
    "name": "M8 Stainless Steel Bolt",
    "quantity": 10000,
    "reorder_point": 2000,
    "warehouse_id": "wh_main",
    "unit": "pcs"
  }
}
```

### `get_item`

Retrieve a stock item by ID.

**Parameters:**

- `id` (required) - Stock item ID

### `list_items`

List stock items with optional filters.

**Parameters:**

- `warehouse_id` (optional) - Filter by warehouse
- `status` (optional) - Filter by status (in_stock, low_stock, out_of_stock)
- `limit` (optional) - Max results

### `adjust_stock`

Record a stock movement (inbound, outbound, or adjustment).

**Parameters:**

- `stock_item_id` (required) - Stock item to adjust
- `type` (required) - Movement type: "in", "out", or "adjustment"
- `quantity` (required) - Quantity to move
- `reason` (optional) - Reason for adjustment
- `reference` (optional) - Reference ID (e.g., order or PO number)

**Example:**

```json
{
  "action": "adjust_stock",
  "params": {
    "stock_item_id": "stk_042",
    "type": "out",
    "quantity": 500,
    "reason": "Order fulfillment",
    "reference": "ord_055"
  }
}
```

### `low_stock_alerts`

Get items at or below their reorder point.

**Parameters:**

- `threshold` (optional) - Override default reorder point check with custom threshold

**Example:**

```json
{ "action": "low_stock_alerts", "params": { "threshold": 100 } }
```

### `stock_movements`

View movement history for a stock item.

**Parameters:**

- `stock_item_id` (required) - Stock item ID
- `limit` (optional) - Max results

## Tips

- Set reorder points on all critical items to enable proactive restocking.
- Always include a reference when adjusting stock so movements are traceable.
- Run `low_stock_alerts` daily to prevent stockouts.
- Use "adjustment" type for corrections like damage, loss, or audit reconciliation.
- Coordinate with `erp_suppliers` to auto-generate POs when stock is low.
