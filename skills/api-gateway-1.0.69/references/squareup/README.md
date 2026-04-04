# Square Routing Reference

**App name:** `squareup`
**Base URL proxied:** `connect.squareup.com`

## API Path Pattern

```
/squareup/v2/{resource}
```

## Merchants

### Get Current Merchant

```bash
GET /squareup/v2/merchants/me
```

## Locations

### List Locations

```bash
GET /squareup/v2/locations
```

### Get Location

```bash
GET /squareup/v2/locations/{location_id}
```

### Create Location

```bash
POST /squareup/v2/locations
Content-Type: application/json

{
  "location": {
    "name": "New Location",
    "address": {...}
  }
}
```

### Update Location

```bash
PUT /squareup/v2/locations/{location_id}
Content-Type: application/json

{
  "location": {"name": "Updated Name"}
}
```

## Customers

### List Customers

```bash
GET /squareup/v2/customers
```

### Get Customer

```bash
GET /squareup/v2/customers/{customer_id}
```

### Create Customer

```bash
POST /squareup/v2/customers
Content-Type: application/json

{
  "given_name": "John",
  "family_name": "Doe",
  "email_address": "john@example.com"
}
```

### Update Customer

```bash
PUT /squareup/v2/customers/{customer_id}
Content-Type: application/json

{
  "given_name": "Jane"
}
```

### Delete Customer

```bash
DELETE /squareup/v2/customers/{customer_id}
```

### Search Customers

```bash
POST /squareup/v2/customers/search
Content-Type: application/json

{
  "query": {
    "filter": {
      "email_address": {"exact": "john@example.com"}
    }
  },
  "limit": 10
}
```

## Payments

### List Payments

```bash
GET /squareup/v2/payments
GET /squareup/v2/payments?location_id={location_id}&begin_time=2026-01-01T00:00:00Z
```

### Get Payment

```bash
GET /squareup/v2/payments/{payment_id}
```

### Create Payment

```bash
POST /squareup/v2/payments
Content-Type: application/json

{
  "source_id": "cnon:card-nonce-ok",
  "idempotency_key": "unique-key",
  "amount_money": {"amount": 1000, "currency": "USD"},
  "location_id": "{location_id}"
}
```

### Complete Payment

```bash
POST /squareup/v2/payments/{payment_id}/complete
```

### Cancel Payment

```bash
POST /squareup/v2/payments/{payment_id}/cancel
```

## Refunds

### List Refunds

```bash
GET /squareup/v2/refunds
```

### Get Refund

```bash
GET /squareup/v2/refunds/{refund_id}
```

### Create Refund

```bash
POST /squareup/v2/refunds
Content-Type: application/json

{
  "idempotency_key": "unique-key",
  "payment_id": "{payment_id}",
  "amount_money": {"amount": 500, "currency": "USD"}
}
```

## Orders

### Create Order

```bash
POST /squareup/v2/orders
Content-Type: application/json

{
  "order": {
    "location_id": "{location_id}",
    "line_items": [
      {
        "name": "Item",
        "quantity": "1",
        "base_price_money": {"amount": 1000, "currency": "USD"}
      }
    ]
  },
  "idempotency_key": "unique-key"
}
```

### Get Order

```bash
GET /squareup/v2/orders/{order_id}
```

### Search Orders

```bash
POST /squareup/v2/orders/search
Content-Type: application/json

{
  "location_ids": ["{location_id}"],
  "limit": 10
}
```

### Update Order

```bash
PUT /squareup/v2/orders/{order_id}
Content-Type: application/json

{
  "order": {
    "location_id": "{location_id}",
    "version": 1
  },
  "idempotency_key": "unique-key"
}
```

### Pay Order

```bash
POST /squareup/v2/orders/{order_id}/pay
Content-Type: application/json

{
  "idempotency_key": "unique-key",
  "payment_ids": ["{payment_id}"]
}
```

## Catalog

### List Catalog

```bash
GET /squareup/v2/catalog/list
GET /squareup/v2/catalog/list?types=ITEM,CATEGORY
```

### Get Catalog Object

```bash
GET /squareup/v2/catalog/object/{object_id}
```

### Upsert Catalog Object

```bash
POST /squareup/v2/catalog/object
Content-Type: application/json

{
  "idempotency_key": "unique-key",
  "object": {
    "type": "ITEM",
    "id": "#new-item",
    "item_data": {
      "name": "Coffee",
      "variations": [
        {
          "type": "ITEM_VARIATION",
          "id": "#variation",
          "item_variation_data": {
            "name": "Regular",
            "pricing_type": "FIXED_PRICING",
            "price_money": {"amount": 500, "currency": "USD"}
          }
        }
      ]
    }
  }
}
```

### Delete Catalog Object

```bash
DELETE /squareup/v2/catalog/object/{object_id}
```

### Search Catalog

```bash
POST /squareup/v2/catalog/search
Content-Type: application/json

{
  "object_types": ["ITEM"],
  "query": {
    "text_query": {"keywords": ["coffee"]}
  }
}
```

### Get Catalog Info

```bash
GET /squareup/v2/catalog/info
```

### Batch Upsert

```bash
POST /squareup/v2/catalog/batch-upsert
Content-Type: application/json

{
  "idempotency_key": "unique-key",
  "batches": [{"objects": [...]}]
}
```

## Invoices

### List Invoices

```bash
GET /squareup/v2/invoices?location_id={location_id}
```

### Get Invoice

```bash
GET /squareup/v2/invoices/{invoice_id}
```

### Create Invoice

```bash
POST /squareup/v2/invoices
Content-Type: application/json

{
  "invoice": {
    "location_id": "{location_id}",
    "order_id": "{order_id}",
    "primary_recipient": {"customer_id": "{customer_id}"},
    "payment_requests": [
      {"request_type": "BALANCE", "due_date": "2026-02-15"}
    ]
  },
  "idempotency_key": "unique-key"
}
```

### Update Invoice

```bash
PUT /squareup/v2/invoices/{invoice_id}
Content-Type: application/json

{
  "invoice": {"version": 1},
  "idempotency_key": "unique-key"
}
```

### Publish Invoice

```bash
POST /squareup/v2/invoices/{invoice_id}/publish
Content-Type: application/json

{"version": 1, "idempotency_key": "unique-key"}
```

### Cancel Invoice

```bash
POST /squareup/v2/invoices/{invoice_id}/cancel
Content-Type: application/json

{"version": 1}
```

### Delete Invoice

```bash
DELETE /squareup/v2/invoices/{invoice_id}
```

## Team Members

### Search Team Members

```bash
POST /squareup/v2/team-members/search
Content-Type: application/json

{
  "query": {
    "filter": {
      "location_ids": ["{location_id}"],
      "status": "ACTIVE"
    }
  }
}
```

### Get Team Member

```bash
GET /squareup/v2/team-members/{team_member_id}
```

### Update Team Member

```bash
PUT /squareup/v2/team-members/{team_member_id}
Content-Type: application/json

{
  "team_member": {
    "given_name": "Updated Name"
  }
}
```

## Loyalty

### List Loyalty Programs

```bash
GET /squareup/v2/loyalty/programs
```

### Get Loyalty Program

```bash
GET /squareup/v2/loyalty/programs/{program_id}
```

### Search Loyalty Accounts

```bash
POST /squareup/v2/loyalty/accounts/search
Content-Type: application/json

{
  "query": {
    "customer_ids": ["{customer_id}"]
  }
}
```

### Create Loyalty Account

```bash
POST /squareup/v2/loyalty/accounts
Content-Type: application/json

{
  "loyalty_account": {
    "program_id": "{program_id}",
    "mapping": {"phone_number": "+15551234567"}
  },
  "idempotency_key": "unique-key"
}
```

## Payment Links (Online Checkout)

### List Payment Links

```bash
GET /squareup/v2/online-checkout/payment-links
```

### Get Payment Link

```bash
GET /squareup/v2/online-checkout/payment-links/{id}
```

### Create Payment Link

```bash
POST /squareup/v2/online-checkout/payment-links
Content-Type: application/json

{
  "idempotency_key": "unique-key",
  "quick_pay": {
    "name": "Test Payment",
    "price_money": {"amount": 1000, "currency": "USD"},
    "location_id": "{location_id}"
  }
}
```

### Update Payment Link

```bash
PUT /squareup/v2/online-checkout/payment-links/{id}
Content-Type: application/json

{
  "payment_link": {"version": 1}
}
```

### Delete Payment Link

```bash
DELETE /squareup/v2/online-checkout/payment-links/{id}
```

## Cards

### List Cards

```bash
GET /squareup/v2/cards
GET /squareup/v2/cards?customer_id={customer_id}
```

### Get Card

```bash
GET /squareup/v2/cards/{card_id}
```

### Create Card

```bash
POST /squareup/v2/cards
Content-Type: application/json

{
  "idempotency_key": "unique-key",
  "source_id": "cnon:card-nonce-ok",
  "card": {
    "customer_id": "{customer_id}"
  }
}
```

### Disable Card

```bash
POST /squareup/v2/cards/{card_id}/disable
```

## Payouts

### List Payouts

```bash
GET /squareup/v2/payouts
GET /squareup/v2/payouts?location_id={location_id}
```

### Get Payout

```bash
GET /squareup/v2/payouts/{payout_id}
```

### List Payout Entries

```bash
GET /squareup/v2/payouts/{payout_id}/payout-entries
```

## Bank Accounts

### List Bank Accounts

```bash
GET /squareup/v2/bank-accounts
```

### Get Bank Account

```bash
GET /squareup/v2/bank-accounts/{bank_account_id}
```

## Terminal

### List Terminal Checkouts

```bash
GET /squareup/v2/terminals/checkouts
```

### Create Terminal Checkout

```bash
POST /squareup/v2/terminals/checkouts
Content-Type: application/json

{
  "idempotency_key": "unique-key",
  "checkout": {
    "amount_money": {"amount": 1000, "currency": "USD"},
    "device_options": {"device_id": "{device_id}"}
  }
}
```

### Search Terminal Checkouts

```bash
POST /squareup/v2/terminals/checkouts/search
Content-Type: application/json

{
  "query": {
    "filter": {
      "status": "COMPLETED"
    }
  }
}
```

## Notes

- All amounts are in smallest currency unit (cents for USD: 1000 = $10.00)
- Most write operations require an `idempotency_key`
- Cursor-based pagination: use `cursor` parameter with value from response
- Timestamps are ISO 8601 format
- Some endpoints require specific OAuth scopes

## Resources

- [Square API Overview](https://developer.squareup.com/docs)
- [Square API Reference](https://developer.squareup.com/reference/square)
- [Payments API](https://developer.squareup.com/reference/square/payments-api)
- [Customers API](https://developer.squareup.com/reference/square/customers-api)
- [Orders API](https://developer.squareup.com/reference/square/orders-api)
- [Catalog API](https://developer.squareup.com/reference/square/catalog-api)
- [Invoices API](https://developer.squareup.com/reference/square/invoices-api)
- [Team Members API](https://developer.squareup.com/reference/square/team-api)
- [Loyalty API](https://developer.squareup.com/reference/square/loyalty-api)
- [Online Checkout API](https://developer.squareup.com/reference/square/online-checkout-api)
