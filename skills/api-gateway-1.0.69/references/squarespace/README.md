# Squarespace Routing Reference

**App name:** `squarespace`
**Base URL proxied:** `api.squarespace.com`

## API Path Pattern

```
/squarespace/v2/commerce/products      # Products API (v2)
/squarespace/1.0/commerce/store_pages  # Store Pages (1.0 only)
/squarespace/1.0/commerce/inventory    # Inventory API
/squarespace/1.0/commerce/orders       # Orders API
/squarespace/1.0/commerce/transactions # Transactions API
/squarespace/1.0/profiles              # Profiles API
```

## Important Notes

- All requests require a `User-Agent` header describing your application
- Requests without a custom User-Agent are subject to stricter rate limits
- Maximum 50 items per batch request
- Idempotency-Key header is required for stock adjustments and order creation
- Rate limit: 300 requests per minute (5 per second)
- Create Order has a stricter rate limit: 100 requests per hour per website

## Common Endpoints

### Inventory

#### List All Inventory

```bash
GET /squarespace/1.0/commerce/inventory
GET /squarespace/1.0/commerce/inventory?cursor={cursor}
```

#### Get Specific Inventory

```bash
GET /squarespace/1.0/commerce/inventory/{variantId1},{variantId2}
```

Max 50 variant IDs per request.

#### Adjust Stock Quantities

```bash
POST /squarespace/1.0/commerce/inventory/adjustments
Content-Type: application/json
Idempotency-Key: unique-key-here

{
  "incrementOperations": [{"variantId": "variant-id", "quantity": 5}],
  "decrementOperations": [{"variantId": "variant-id", "quantity": 2}],
  "setFiniteOperations": [{"variantId": "variant-id", "quantity": 100}],
  "setUnlimitedOperations": ["variant-id"]
}
```

### Orders

#### List All Orders

```bash
GET /squarespace/1.0/commerce/orders
GET /squarespace/1.0/commerce/orders?fulfillmentStatus=PENDING
GET /squarespace/1.0/commerce/orders?modifiedAfter=2024-01-01T00:00:00Z&modifiedBefore=2024-12-31T23:59:59Z
GET /squarespace/1.0/commerce/orders?customerId={customerId}
```

Note: Cannot combine `cursor` with date range parameters.

#### Get Specific Order

```bash
GET /squarespace/1.0/commerce/orders/{orderId}
```

#### Create Order

```bash
POST /squarespace/1.0/commerce/orders
Content-Type: application/json
Idempotency-Key: unique-key-here

{
  "channelName": "External Store",
  "externalOrderReference": "ORDER-12345",
  "customerEmail": "customer@example.com",
  "lineItems": [
    {
      "lineItemType": "PHYSICAL_PRODUCT",
      "variantId": "variant-id",
      "quantity": 2,
      "unitPricePaid": {"currency": "USD", "value": "29.99"}
    }
  ],
  "subtotal": {"currency": "USD", "value": "59.98"},
  "priceTaxInterpretation": "EXCLUSIVE",
  "grandTotal": {"currency": "USD", "value": "59.98"},
  "createdOn": "2024-01-15T10:30:00Z"
}
```

Note: `subtotal` must equal sum of `lineItems.unitPricePaid.value * quantity`.

#### Fulfill Order

```bash
POST /squarespace/1.0/commerce/orders/{orderId}/fulfillments
Content-Type: application/json

{
  "shouldSendNotification": true,
  "shipments": [
    {
      "shipDate": "2024-01-16T08:00:00Z",
      "carrierName": "USPS",
      "service": "Priority Mail",
      "trackingNumber": "9400111899223456789012",
      "trackingUrl": "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223456789012"
    }
  ]
}
```

### Products (v2 API)

#### List Store Pages

```bash
GET /squarespace/1.0/commerce/store_pages
```

Note: Store Pages endpoint uses v1.0 (no v2 available).

#### List All Products

```bash
GET /squarespace/v2/commerce/products
GET /squarespace/v2/commerce/products?type=PHYSICAL,SERVICE,GIFT_CARD,DIGITAL
GET /squarespace/v2/commerce/products?modifiedAfter=2024-01-01T00:00:00Z
```

Note: Cannot combine `cursor` with date/type filters.

#### Get Specific Products

```bash
GET /squarespace/v2/commerce/products/{productId1},{productId2}
```

Max 50 product IDs per request.

#### Create Product

```bash
POST /squarespace/v2/commerce/products
Content-Type: application/json

{
  "type": "PHYSICAL",
  "storePageId": "store-page-id",
  "name": "New Product",
  "description": "<p>Product description</p>",
  "urlSlug": "new-product",
  "isVisible": true,
  "variants": [
    {
      "sku": "SKU-001",
      "pricing": {"basePrice": {"currency": "USD", "value": "49.99"}},
      "stock": {"quantity": 100, "unlimited": false}
    }
  ]
}
```

#### Update Product

```bash
POST /squarespace/v2/commerce/products/{productId}
Content-Type: application/json

{
  "name": "Updated Product Name",
  "isVisible": true
}
```

#### Delete Product

```bash
DELETE /squarespace/v2/commerce/products/{productId}
```

### Product Variants (v2 API)

#### Create Variant

```bash
POST /squarespace/v2/commerce/products/{productId}/variants
Content-Type: application/json

{
  "sku": "SKU-002",
  "pricing": {"basePrice": {"currency": "USD", "value": "59.99"}},
  "stock": {"quantity": 50, "unlimited": false},
  "attributes": {"Size": "Large"}
}
```

Note: To use `attributes`, product must have matching `variantAttributes` set first via Update Product.

#### Update Variant

```bash
POST /squarespace/v2/commerce/products/{productId}/variants/{variantId}
Content-Type: application/json

{
  "sku": "SKU-002-UPDATED",
  "pricing": {"basePrice": {"currency": "USD", "value": "64.99"}}
}
```

#### Delete Variant

```bash
DELETE /squarespace/v2/commerce/products/{productId}/variants/{variantId}
```

### Product Images (v2 API)

#### Upload Image

```bash
POST /squarespace/v2/commerce/products/{productId}/images
Content-Type: multipart/form-data

curl "https://gateway.maton.ai/squarespace/v2/commerce/products/{productId}/images" \
  -H "Authorization: Bearer $MATON_API_KEY" \
  -H "User-Agent: MyClaude/1.0" \
  -X POST \
  -F file=@image.png
```

#### Check Upload Status

```bash
GET /squarespace/v2/commerce/products/{productId}/images/{imageId}/status
```

#### Update Image Alt Text

```bash
POST /squarespace/v2/commerce/products/{productId}/images/{imageId}
Content-Type: application/json

{"altText": "Product image description"}
```

#### Reorder Image

```bash
POST /squarespace/v2/commerce/products/{productId}/images/{imageId}/order
Content-Type: application/json

{"afterImageId": "other-image-id"}
```

#### Assign Image to Variant

```bash
POST /squarespace/v2/commerce/products/{productId}/variants/{variantId}/image
Content-Type: application/json

{"imageId": "image-id"}
```

#### Delete Image

```bash
DELETE /squarespace/v2/commerce/products/{productId}/images/{imageId}
```

### Profiles (Customers)

#### List All Profiles

```bash
GET /squarespace/1.0/profiles
GET /squarespace/1.0/profiles?filter=isCustomer,true
GET /squarespace/1.0/profiles?sortField=email&sortDirection=asc
```

Filters (semicolon-separated):

- `isCustomer,true` or `isCustomer,false`
- `hasAccount,true` or `hasAccount,false`
- `email,customer@example.com`

Sort fields: `createdOn`, `id`, `email`, `lastName`

#### Get Specific Profiles

```bash
GET /squarespace/1.0/profiles/{profileId1},{profileId2}
```

Max 50 profile IDs per request.

### Transactions

#### List All Transactions

```bash
GET /squarespace/1.0/commerce/transactions
GET /squarespace/1.0/commerce/transactions?modifiedAfter=2024-01-01T00:00:00Z&modifiedBefore=2024-12-31T23:59:59Z
```

Note: Date filters must be used together (both `modifiedAfter` and `modifiedBefore` required).

#### Get Specific Transactions

```bash
GET /squarespace/1.0/commerce/transactions/{documentId1},{documentId2}
```

Max 50 document IDs per request.

## Pagination

Squarespace uses cursor-based pagination:

```json
{
  "pagination": {
    "hasNextPage": true,
    "nextPageCursor": "cursor-value",
    "nextPageUrl": "https://api.squarespace.com/..."
  }
}
```

Use the `cursor` parameter to get the next page:

```bash
GET /squarespace/v2/commerce/products?cursor=cursor-value
```

## Resources

- [Squarespace Commerce APIs Overview](https://developers.squarespace.com/commerce-apis/overview)
- [Inventory API](https://developers.squarespace.com/commerce-apis/inventory-overview)
- [Orders API](https://developers.squarespace.com/commerce-apis/orders-overview)
- [Products API](https://developers.squarespace.com/commerce-apis/products-overview)
- [Profiles API](https://developers.squarespace.com/commerce-apis/profiles-overview)
- [Transactions API](https://developers.squarespace.com/commerce-apis/transactions-overview)
