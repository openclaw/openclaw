# Gumroad Routing Reference

**App name:** `gumroad`
**Base URL proxied:** `api.gumroad.com`

## API Path Pattern

```
/gumroad/v2/{resource}
```

## Common Endpoints

### Get Current User

```bash
GET /gumroad/v2/user
```

### List Products

```bash
GET /gumroad/v2/products
```

### Get Product

```bash
GET /gumroad/v2/products/{product_id}
```

### Update Product

```bash
PUT /gumroad/v2/products/{product_id}
Content-Type: application/x-www-form-urlencoded

name=Updated%20Name
```

### Delete Product

```bash
DELETE /gumroad/v2/products/{product_id}
```

### List Sales

```bash
GET /gumroad/v2/sales
GET /gumroad/v2/sales?after=2026-01-01&before=2026-12-31
```

### Get Sale

```bash
GET /gumroad/v2/sales/{sale_id}
```

### List Subscribers

```bash
GET /gumroad/v2/products/{product_id}/subscribers
```

### Get Subscriber

```bash
GET /gumroad/v2/subscribers/{subscriber_id}
```

### Verify License

```bash
POST /gumroad/v2/licenses/verify
Content-Type: application/x-www-form-urlencoded

product_id={product_id}&license_key={license_key}
```

### Enable/Disable License

```bash
PUT /gumroad/v2/licenses/enable
PUT /gumroad/v2/licenses/disable
```

### List Resource Subscriptions (Webhooks)

```bash
GET /gumroad/v2/resource_subscriptions?resource_name=sale
```

Resource names: `sale`, `refund`, `dispute`, `dispute_won`, `cancellation`, `subscription_updated`, `subscription_ended`, `subscription_restarted`

### Create Resource Subscription

```bash
PUT /gumroad/v2/resource_subscriptions
Content-Type: application/x-www-form-urlencoded

resource_name=sale&post_url=https://example.com/webhook
```

### Delete Resource Subscription

```bash
DELETE /gumroad/v2/resource_subscriptions/{resource_subscription_id}
```

### Offer Codes

```bash
GET /gumroad/v2/products/{product_id}/offer_codes
POST /gumroad/v2/products/{product_id}/offer_codes
PUT /gumroad/v2/products/{product_id}/offer_codes/{offer_code_id}
DELETE /gumroad/v2/products/{product_id}/offer_codes/{offer_code_id}
```

### Variant Categories

```bash
GET /gumroad/v2/products/{product_id}/variant_categories
POST /gumroad/v2/products/{product_id}/variant_categories
DELETE /gumroad/v2/products/{product_id}/variant_categories/{variant_category_id}
```

### Variants

```bash
GET /gumroad/v2/products/{product_id}/variant_categories/{variant_category_id}/variants
POST /gumroad/v2/products/{product_id}/variant_categories/{variant_category_id}/variants
PUT /gumroad/v2/products/{product_id}/variant_categories/{variant_category_id}/variants/{variant_id}
DELETE /gumroad/v2/products/{product_id}/variant_categories/{variant_category_id}/variants/{variant_id}
```

### Custom Fields

```bash
GET /gumroad/v2/products/{product_id}/custom_fields
POST /gumroad/v2/products/{product_id}/custom_fields
PUT /gumroad/v2/products/{product_id}/custom_fields/{name}
DELETE /gumroad/v2/products/{product_id}/custom_fields/{name}
```

## Pagination

Page-based pagination:

```bash
GET /gumroad/v2/sales?page=1
GET /gumroad/v2/sales?page=2
```

## Notes

- All responses include `success` boolean field
- Product creation not available via API
- POST/PUT use `application/x-www-form-urlencoded` (not JSON)
- Prices in cents (500 = $5.00)
- License keys are case-insensitive

## Resources

- [Gumroad API Documentation](https://gumroad.com/api)
- [Create API Application](https://help.gumroad.com/article/280-create-application-api)
