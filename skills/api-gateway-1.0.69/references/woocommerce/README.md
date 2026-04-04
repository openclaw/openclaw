# WooCommerce Routing Reference

**App name:** `woocommerce`
**Base URL proxied:** `{store-url}/wp-json/wc/v3`

## API Path Pattern

```
/woocommerce/wp-json/wc/v3/{endpoint}
```

## Common Endpoints

### Products

#### List Products

```bash
GET /woocommerce/wp-json/wc/v3/products?per_page=20&status=publish
```

#### Get Product

```bash
GET /woocommerce/wp-json/wc/v3/products/{id}
```

#### Create Product

```bash
POST /woocommerce/wp-json/wc/v3/products
Content-Type: application/json

{"name": "Premium Widget", "type": "simple", "regular_price": "19.99", "sku": "WDG-001"}
```

#### Update Product

```bash
PUT /woocommerce/wp-json/wc/v3/products/{id}
Content-Type: application/json

{"regular_price": "24.99", "sale_price": "19.99"}
```

#### Delete Product

```bash
DELETE /woocommerce/wp-json/wc/v3/products/{id}?force=true
```

### Product Variations

#### List Variations

```bash
GET /woocommerce/wp-json/wc/v3/products/{product_id}/variations
```

#### Create Variation

```bash
POST /woocommerce/wp-json/wc/v3/products/{product_id}/variations
Content-Type: application/json

{"regular_price": "29.99", "sku": "TSH-001-RED-M", "attributes": [{"id": 1, "option": "Red"}]}
```

### Product Categories

#### List Categories

```bash
GET /woocommerce/wp-json/wc/v3/products/categories
```

#### Create Category

```bash
POST /woocommerce/wp-json/wc/v3/products/categories
Content-Type: application/json

{"name": "Electronics", "description": "Electronic products"}
```

### Orders

#### List Orders

```bash
GET /woocommerce/wp-json/wc/v3/orders?status=processing&per_page=50
```

#### Get Order

```bash
GET /woocommerce/wp-json/wc/v3/orders/{id}
```

#### Create Order

```bash
POST /woocommerce/wp-json/wc/v3/orders
Content-Type: application/json

{"payment_method": "stripe", "set_paid": true, "billing": {"first_name": "John", "last_name": "Doe", "email": "john@example.com"}, "line_items": [{"product_id": 123, "quantity": 2}]}
```

#### Update Order Status

```bash
PUT /woocommerce/wp-json/wc/v3/orders/{id}
Content-Type: application/json

{"status": "completed"}
```

### Order Notes

#### List Order Notes

```bash
GET /woocommerce/wp-json/wc/v3/orders/{order_id}/notes
```

#### Create Order Note

```bash
POST /woocommerce/wp-json/wc/v3/orders/{order_id}/notes
Content-Type: application/json

{"note": "Order shipped via FedEx", "customer_note": true}
```

### Order Refunds

#### Create Refund

```bash
POST /woocommerce/wp-json/wc/v3/orders/{order_id}/refunds
Content-Type: application/json

{"amount": "25.00", "reason": "Product damaged", "api_refund": true}
```

### Customers

#### List Customers

```bash
GET /woocommerce/wp-json/wc/v3/customers?per_page=25
```

#### Get Customer

```bash
GET /woocommerce/wp-json/wc/v3/customers/{id}
```

#### Create Customer

```bash
POST /woocommerce/wp-json/wc/v3/customers
Content-Type: application/json

{"email": "jane@example.com", "first_name": "Jane", "last_name": "Smith", "username": "janesmith"}
```

### Coupons

#### List Coupons

```bash
GET /woocommerce/wp-json/wc/v3/coupons
```

#### Create Coupon

```bash
POST /woocommerce/wp-json/wc/v3/coupons
Content-Type: application/json

{"code": "SUMMER2024", "discount_type": "percent", "amount": "15", "usage_limit": 100}
```

### Taxes

#### List Tax Rates

```bash
GET /woocommerce/wp-json/wc/v3/taxes
```

#### Create Tax Rate

```bash
POST /woocommerce/wp-json/wc/v3/taxes
Content-Type: application/json

{"country": "US", "state": "CA", "rate": "7.25", "name": "CA State Tax"}
```

### Shipping

#### List Shipping Zones

```bash
GET /woocommerce/wp-json/wc/v3/shipping/zones
```

#### List Shipping Zone Methods

```bash
GET /woocommerce/wp-json/wc/v3/shipping/zones/{zone_id}/methods
```

### Webhooks

#### List Webhooks

```bash
GET /woocommerce/wp-json/wc/v3/webhooks
```

#### Create Webhook

```bash
POST /woocommerce/wp-json/wc/v3/webhooks
Content-Type: application/json

{"name": "Order Created", "topic": "order.created", "delivery_url": "https://example.com/webhook", "status": "active"}
```

### Reports

#### Sales Report

```bash
GET /woocommerce/wp-json/wc/v3/reports/sales?period=month
```

#### Top Sellers

```bash
GET /woocommerce/wp-json/wc/v3/reports/top_sellers
```

#### Orders Totals

```bash
GET /woocommerce/wp-json/wc/v3/reports/orders/totals
```

### Settings

#### List Settings Groups

```bash
GET /woocommerce/wp-json/wc/v3/settings
```

#### Get Settings in Group

```bash
GET /woocommerce/wp-json/wc/v3/settings/{group}
```

### System Status

#### Get System Status

```bash
GET /woocommerce/wp-json/wc/v3/system_status
```

## Notes

- All monetary amounts are returned as strings with two decimal places
- Dates are in ISO8601 format: `YYYY-MM-DDTHH:MM:SS`
- Resource IDs are integers
- Pagination uses `page` and `per_page` parameters (max 100 per page)
- Response headers include `X-WP-Total` and `X-WP-TotalPages`
- Order statuses: `pending`, `processing`, `on-hold`, `completed`, `cancelled`, `refunded`, `failed`
- Discount types: `percent`, `fixed_cart`, `fixed_product`
- Use `force=true` query parameter to permanently delete (otherwise moves to trash)
- Batch operations supported via `POST /{resource}/batch` with `create`, `update`, `delete` arrays

## Resources

- [WooCommerce REST API Documentation](https://woocommerce.github.io/woocommerce-rest-api-docs/)
- [Products](https://woocommerce.github.io/woocommerce-rest-api-docs/#products)
- [Product Variations](https://woocommerce.github.io/woocommerce-rest-api-docs/#product-variations)
- [Product Attributes](https://woocommerce.github.io/woocommerce-rest-api-docs/#product-attributes)
- [Product Categories](https://woocommerce.github.io/woocommerce-rest-api-docs/#product-categories)
- [Product Tags](https://woocommerce.github.io/woocommerce-rest-api-docs/#product-tags)
- [Product Reviews](https://woocommerce.github.io/woocommerce-rest-api-docs/#product-reviews)
- [Orders](https://woocommerce.github.io/woocommerce-rest-api-docs/#orders)
- [Order Notes](https://woocommerce.github.io/woocommerce-rest-api-docs/#order-notes)
- [Refunds](https://woocommerce.github.io/woocommerce-rest-api-docs/#refunds)
- [Customers](https://woocommerce.github.io/woocommerce-rest-api-docs/#customers)
- [Coupons](https://woocommerce.github.io/woocommerce-rest-api-docs/#coupons)
- [Tax Rates](https://woocommerce.github.io/woocommerce-rest-api-docs/#tax-rates)
- [Tax Classes](https://woocommerce.github.io/woocommerce-rest-api-docs/#tax-classes)
- [Shipping Zones](https://woocommerce.github.io/woocommerce-rest-api-docs/#shipping-zones)
- [Shipping Methods](https://woocommerce.github.io/woocommerce-rest-api-docs/#shipping-methods)
- [Payment Gateways](https://woocommerce.github.io/woocommerce-rest-api-docs/#payment-gateways)
- [Settings](https://woocommerce.github.io/woocommerce-rest-api-docs/#settings)
- [Webhooks](https://woocommerce.github.io/woocommerce-rest-api-docs/#webhooks)
- [Reports](https://woocommerce.github.io/woocommerce-rest-api-docs/#reports)
- [System Status](https://woocommerce.github.io/woocommerce-rest-api-docs/#system-status)
