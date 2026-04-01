# ERP E-Commerce Tools

## Tool: `erp_ecommerce`

Manage products, customer orders, and fulfillment workflows. Tracks inventory-linked product catalogs and order lifecycle from placement to delivery.

## Actions

### `create_product`

Add a new product to the catalog.

**Parameters:**

- `name` (required) - Product name
- `sku` (required) - Unique stock-keeping unit
- `price` (required) - Unit price
- `currency` (optional) - Currency code (default: USD)
- `category` (optional) - Product category
- `stock_qty` (optional) - Initial stock quantity

**Example:**

```json
{
  "action": "create_product",
  "params": {
    "name": "Wireless Keyboard",
    "sku": "KB-WL-001",
    "price": 79.99,
    "category": "peripherals",
    "stock_qty": 250
  }
}
```

### `get_product`

Retrieve a product by ID.

**Parameters:**

- `id` (required) - Product ID

### `list_products`

List products with optional filters.

**Parameters:**

- `category` (optional) - Filter by category
- `status` (optional) - Filter by status (active, draft, discontinued)
- `limit` (optional) - Max results

### `update_product`

Update product fields.

**Parameters:**

- `id` (required) - Product ID
- Additional fields to update (name, price, category, stock_qty, status)

### `create_order`

Place a new customer order.

**Parameters:**

- `customer_id` (required) - Customer placing the order
- `items` (required) - Array of {product_id, quantity, unit_price}

**Example:**

```json
{
  "action": "create_order",
  "params": {
    "customer_id": "cust_001",
    "items": [{ "product_id": "prod_010", "quantity": 2, "unit_price": 79.99 }]
  }
}
```

### `get_order`

Retrieve an order by ID.

**Parameters:**

- `id` (required) - Order ID

### `list_orders`

List orders with optional filters.

**Parameters:**

- `status` (optional) - Filter by status (pending, processing, shipped, delivered, cancelled)
- `customer_id` (optional) - Filter by customer
- `limit` (optional) - Max results

### `update_order_status`

Advance or change order status.

**Parameters:**

- `id` (required) - Order ID
- `status` (required) - New status

**Example:**

```json
{ "action": "update_order_status", "params": { "id": "ord_055", "status": "shipped" } }
```

## Tips

- SKUs must be unique — check with `list_products` before creating duplicates.
- Link orders to customers for full purchase history visibility.
- Use `update_order_status` to move orders through the fulfillment pipeline.
- Coordinate with `erp_inventory` to keep stock_qty in sync after order fulfillment.
- Set products to "discontinued" rather than deleting to preserve order history.
