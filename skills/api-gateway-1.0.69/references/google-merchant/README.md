# Google Merchant Routing Reference

**App name:** `google-merchant`
**Base URL proxied:** `merchantapi.googleapis.com`

## API Path Pattern

```
/google-merchant/{sub-api}/{version}/accounts/{accountId}/{resource}
```

The Merchant API uses sub-APIs: `products`, `accounts`, `datasources`, `reports`, `promotions`, `inventories`, `notifications`, `conversions`

**Important:** The v1 API requires one-time developer registration per Merchant Center account. Complete the registration steps below before using any endpoints.

## Developer Registration

Before using v1 endpoints, you must complete a one-time registration:

### Step 1: Get Your Account ID

**Option A: Try fetching via API first**

Try listing accounts using the v1beta endpoint. If this works, you can get your account ID automatically:

```bash
GET /google-merchant/accounts/v1beta/accounts
```

Response (if successful):

```json
{
  "accounts": [{ "accountId": "123456789", "accountName": "My Store" }]
}
```

**Option B: From Merchant Center UI (if Option A fails)**

If the v1beta endpoint is unavailable or returns an error:

1. Log in to [Google Merchant Center](https://merchants.google.com/)
2. Your account ID is in the URL: `https://merchants.google.com/mc/overview?a=YOUR_ACCOUNT_ID`

For example, if your URL is `https://merchants.google.com/mc/overview?a=123456789`, your account ID is `123456789`.

### Step 2: Register for API Access

```bash
POST /google-merchant/accounts/v1/accounts/{accountId}/developerRegistration:registerGcp
Content-Type: application/json

{
  "developerEmail": "your-email@example.com"
}
```

Replace `{accountId}` with your account ID from Step 1, and use the email associated with your Google account.

**Response:**

```json
{
  "name": "accounts/123456789/developerRegistration",
  "gcpIds": ["..."]
}
```

### Step 3: Verify Registration

After registration, test that v1 endpoints work:

```bash
GET /google-merchant/accounts/v1/accounts/{accountId}
```

**Note:** Registration only needs to be done once per Merchant Center account. After successful registration, all v1 endpoints will work for that account.

## Common Endpoints

### List Accounts

```bash
GET /google-merchant/accounts/v1/accounts
```

### List Products

```bash
GET /google-merchant/products/v1/accounts/{accountId}/products
```

### Get Product

```bash
GET /google-merchant/products/v1/accounts/{accountId}/products/{productId}
```

Product ID format: `contentLanguage~feedLabel~offerId` (e.g., `en~US~sku123`)

### Insert Product Input

```bash
POST /google-merchant/products/v1/accounts/{accountId}/productInputs:insert?dataSource=accounts/{accountId}/dataSources/{dataSourceId}
Content-Type: application/json

{
  "offerId": "sku123",
  "contentLanguage": "en",
  "feedLabel": "US",
  "productAttributes": {
    "title": "Product Title",
    "link": "https://example.com/product",
    "imageLink": "https://example.com/image.jpg",
    "availability": "in_stock",
    "price": {"amountMicros": "19990000", "currencyCode": "USD"}
  }
}
```

### Delete Product Input

```bash
DELETE /google-merchant/products/v1/accounts/{accountId}/productInputs/{productId}?dataSource=accounts/{accountId}/dataSources/{dataSourceId}
```

### List Data Sources

```bash
GET /google-merchant/datasources/v1/accounts/{accountId}/dataSources
```

### Search Reports

```bash
POST /google-merchant/reports/v1/accounts/{accountId}/reports:search
Content-Type: application/json

{
  "query": "SELECT id, offer_id, title FROM product_view LIMIT 10"
}
```

Note: The `product_view` table requires the `id` field in SELECT clause.

### List Promotions

```bash
GET /google-merchant/promotions/v1/accounts/{accountId}/promotions
```

Note: Requires Promotions program enrollment.

### Get Account

```bash
GET /google-merchant/accounts/v1/accounts/{accountId}
```

### List Regional Inventories

```bash
GET /google-merchant/inventories/v1/accounts/{accountId}/products/{productId}/regionalInventories
```

### List Local Inventories

```bash
GET /google-merchant/inventories/v1/accounts/{accountId}/products/{productId}/localInventories
```

Note: Local inventories only work for products with LOCAL channel.

## Notes

- **Developer registration required** - Complete registration before using v1 endpoints
- Authentication is automatic - the router injects the OAuth token
- Account ID is your Merchant Center numeric ID (visible in MC URL)
- Product IDs use format `contentLanguage~feedLabel~offerId`
- Monetary values use micros (divide by 1,000,000)
- Products can only be inserted in data sources with `input: "API"` type
- Uses token-based pagination with `pageSize` and `pageToken`
- Promotions require account enrollment in Promotions program
- Local inventories only work for LOCAL channel products

## Resources

- [Merchant API Overview](https://developers.google.com/merchant/api/overview)
- [Merchant API Reference](https://developers.google.com/merchant/api/reference/rest)
- [Products Guide](https://developers.google.com/merchant/api/guides/products/overview)
- [Reports Guide](https://developers.google.com/merchant/api/guides/reports)
