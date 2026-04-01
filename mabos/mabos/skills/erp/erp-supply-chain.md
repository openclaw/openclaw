# ERP Supply Chain Tools

## Tool: `erp_supply_chain`

Manage shipments, tracking, and logistics routes. Coordinate the movement of goods from suppliers through warehouses to customers.

## Actions

### `create_shipment`

Create a new shipment record.

**Parameters:**

- `origin` (required) - Origin location or address
- `destination` (required) - Destination location or address
- `order_id` (optional) - Related customer order ID
- `supplier_id` (optional) - Related supplier ID
- `carrier` (optional) - Carrier or logistics provider
- `tracking_number` (optional) - External tracking number
- `estimated_arrival` (optional) - ETA (ISO 8601)

**Example:**

```json
{
  "action": "create_shipment",
  "params": {
    "origin": "Warehouse A, Chicago",
    "destination": "Customer, NYC",
    "order_id": "ord_055",
    "carrier": "FedEx",
    "tracking_number": "FX123456789",
    "estimated_arrival": "2026-02-25"
  }
}
```

### `get_shipment`

Retrieve a shipment by ID.

**Parameters:**

- `id` (required) - Shipment ID

### `list_shipments`

List shipments with optional filters.

**Parameters:**

- `status` (optional) - Filter by status (preparing, in_transit, delivered, delayed)
- `supplier_id` (optional) - Filter by supplier
- `limit` (optional) - Max results

### `update_shipment_status`

Update the status of a shipment.

**Parameters:**

- `id` (required) - Shipment ID
- `status` (required) - New status

### `track_shipment`

Look up shipment details by tracking number.

**Parameters:**

- `tracking_number` (required) - External tracking number

**Example:**

```json
{ "action": "track_shipment", "params": { "tracking_number": "FX123456789" } }
```

### `create_route`

Define a logistics route with multiple legs.

**Parameters:**

- `name` (required) - Route name
- `origin` (required) - Starting point
- `destination` (required) - Final destination
- `legs` (required) - Array of {from, to, carrier, duration}

**Example:**

```json
{
  "action": "create_route",
  "params": {
    "name": "US-East Express",
    "origin": "Chicago, IL",
    "destination": "New York, NY",
    "legs": [
      { "from": "Chicago", "to": "Pittsburgh", "carrier": "FreightCo", "duration": "8h" },
      { "from": "Pittsburgh", "to": "New York", "carrier": "FreightCo", "duration": "6h" }
    ]
  }
}
```

### `list_routes`

List all defined logistics routes.

**Parameters:**

- `limit` (optional) - Max results

### `get_route`

Retrieve a route by ID.

**Parameters:**

- `id` (required) - Route ID

## Tips

- Link shipments to orders or suppliers so all parties can track delivery progress.
- Use `track_shipment` with the external tracking number for quick lookups.
- Define reusable routes for common shipping corridors to speed up shipment creation.
- Monitor "delayed" shipments actively and escalate when ETAs are missed.
