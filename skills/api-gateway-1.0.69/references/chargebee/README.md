# Chargebee Routing Reference

**App name:** `chargebee`
**Base URL proxied:** `{subdomain}.chargebee.com`

The router automatically handles the subdomain from your connection.

## API Path Pattern

```
/chargebee/api/v2/{endpoint}
```

## Common Endpoints

### Customers

#### List Customers

```bash
GET /chargebee/api/v2/customers?limit=10
```

#### Get Customer

```bash
GET /chargebee/api/v2/customers/{customerId}
```

#### Create Customer

```bash
POST /chargebee/api/v2/customers
Content-Type: application/x-www-form-urlencoded

first_name=John&last_name=Doe&email=john@example.com
```

#### Update Customer

```bash
POST /chargebee/api/v2/customers/{customerId}
Content-Type: application/x-www-form-urlencoded

first_name=Jane
```

### Subscriptions

#### List Subscriptions

```bash
GET /chargebee/api/v2/subscriptions?limit=10
```

#### Get Subscription

```bash
GET /chargebee/api/v2/subscriptions/{subscriptionId}
```

#### Create Subscription

```bash
POST /chargebee/api/v2/subscriptions
Content-Type: application/x-www-form-urlencoded

plan_id=basic-plan&customer[email]=john@example.com&customer[first_name]=John
```

#### Cancel Subscription

```bash
POST /chargebee/api/v2/subscriptions/{subscriptionId}/cancel
Content-Type: application/x-www-form-urlencoded

end_of_term=true
```

### Item Prices (Product Catalog 2.0)

#### List Item Prices

```bash
GET /chargebee/api/v2/item_prices?limit=10
```

#### Get Item Price

```bash
GET /chargebee/api/v2/item_prices/{itemPriceId}
```

### Items (Product Catalog 2.0)

#### List Items

```bash
GET /chargebee/api/v2/items?limit=10
```

#### Get Item

```bash
GET /chargebee/api/v2/items/{itemId}
```

### Plans (Product Catalog 1.0 - Legacy)

#### List Plans

```bash
GET /chargebee/api/v2/plans?limit=10
```

#### Get Plan

```bash
GET /chargebee/api/v2/plans/{planId}
```

### Invoices

#### List Invoices

```bash
GET /chargebee/api/v2/invoices?limit=10
```

#### Get Invoice

```bash
GET /chargebee/api/v2/invoices/{invoiceId}
```

#### Download Invoice PDF

```bash
POST /chargebee/api/v2/invoices/{invoiceId}/pdf
```

### Transactions

#### List Transactions

```bash
GET /chargebee/api/v2/transactions?limit=10
```

### Hosted Pages

#### Checkout New Subscription

```bash
POST /chargebee/api/v2/hosted_pages/checkout_new_for_items
Content-Type: application/x-www-form-urlencoded

subscription[plan_id]=basic-plan&customer[email]=john@example.com
```

#### Manage Payment Sources

```bash
POST /chargebee/api/v2/hosted_pages/manage_payment_sources
Content-Type: application/x-www-form-urlencoded

customer[id]=cust_123
```

### Portal Sessions

#### Create Portal Session

```bash
POST /chargebee/api/v2/portal_sessions
Content-Type: application/x-www-form-urlencoded

customer[id]=cust_123
```

## Filtering

Use filter parameters:

```bash
GET /chargebee/api/v2/subscriptions?status[is]=active
GET /chargebee/api/v2/customers?email[is]=john@example.com
GET /chargebee/api/v2/invoices?date[after]=1704067200
```

## Notes

- Authentication is automatic - the router injects Basic auth from your API key
- Subdomain is automatically determined from your connection
- Uses form-urlencoded data for POST requests
- Nested objects use bracket notation: `customer[email]`
- Timestamps are Unix timestamps
- List responses include `next_offset` for pagination
- Status values: `active`, `cancelled`, `non_renewing`, etc.
- **Product Catalog versions**: Use `item_prices` and `items` for PC 2.0, or `plans` and `addons` for PC 1.0

## Resources

- [Getting Started](https://apidocs.chargebee.com/docs/api)
- [List Customers](https://apidocs.chargebee.com/docs/api/customers/list-customers.md)
- [Retrieve a Customer](https://apidocs.chargebee.com/docs/api/customers/retrieve-a-customer.md)
- [Create a Customer](https://apidocs.chargebee.com/docs/api/customers/create-a-customer.md)
- [Update a Customer](https://apidocs.chargebee.com/docs/api/customers/update-a-customer.md)
- [List Subscriptions](https://apidocs.chargebee.com/docs/api/subscriptions/list-subscriptions.md)
- [Retrieve a Subscription](https://apidocs.chargebee.com/docs/api/subscriptions/retrieve-a-subscription.md)
- [Create a Subscription](https://apidocs.chargebee.com/docs/api/subscriptions/create-subscription-for-items.md)
- [Cancel a Subscription](https://apidocs.chargebee.com/docs/api/subscriptions/cancel-subscription-for-items.md)
- [List Items](https://apidocs.chargebee.com/docs/api/items/list-items.md)
- [Retrieve an Item](https://apidocs.chargebee.com/docs/api/items/retrieve-an-item.md)
- [List Item Prices](https://apidocs.chargebee.com/docs/api/item_prices/list-item-prices.md)
- [Retrieve an Item Price](https://apidocs.chargebee.com/docs/api/item_prices/retrieve-an-item-price.md)
- [List Plans](https://apidocs.chargebee.com/docs/api/v2/pcv-1/plans/list-plans.md)
- [Retrieve a Plan](https://apidocs.chargebee.com/docs/api/v2/pcv-1/plans/retrieve-a-plan.md)
- [List Invoices](https://apidocs.chargebee.com/docs/api/invoices/list-invoices.md)
- [Retrieve an Invoice](https://apidocs.chargebee.com/docs/api/invoices/retrieve-an-invoice.md)
- [Download Invoice as PDF](https://apidocs.chargebee.com/docs/api/invoices/download-e-invoice.md)
- [List Transactions](https://apidocs.chargebee.com/docs/api/transactions/list-transactions.md)
- [Checkout New Subscription](https://apidocs.chargebee.com/docs/api/hosted_pages/create-checkout-for-a-new-subscription.md)
- [Manage Payment Sources](https://apidocs.chargebee.com/docs/api/hosted_pages/manage-payment-sources.md)
- [Create a Portal Session](https://apidocs.chargebee.com/docs/api/portal_sessions/create-a-portal-session.md)
