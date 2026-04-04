# Stripe Routing Reference

**App name:** `stripe`
**Base URL proxied:** `api.stripe.com`

## API Path Pattern

```
/stripe/v1/{endpoint}
```

## Common Endpoints

### Customers

#### List Customers

```bash
GET /stripe/v1/customers?limit=10
```

#### Get Customer

```bash
GET /stripe/v1/customers/{customerId}
```

#### Create Customer

```bash
POST /stripe/v1/customers
Content-Type: application/x-www-form-urlencoded

email=customer@example.com&name=John%20Doe&description=New%20customer
```

#### Update Customer

```bash
POST /stripe/v1/customers/{customerId}
Content-Type: application/x-www-form-urlencoded

email=newemail@example.com
```

### Products

#### List Products

```bash
GET /stripe/v1/products?limit=10&active=true
```

#### Create Product

```bash
POST /stripe/v1/products
Content-Type: application/x-www-form-urlencoded

name=Premium%20Plan&description=Monthly%20subscription
```

### Prices

#### List Prices

```bash
GET /stripe/v1/prices?limit=10&active=true
```

#### Create Price

```bash
POST /stripe/v1/prices
Content-Type: application/x-www-form-urlencoded

unit_amount=1999&currency=usd&product=prod_XXX&recurring[interval]=month
```

### Subscriptions

#### List Subscriptions

```bash
GET /stripe/v1/subscriptions?limit=10&status=active
```

#### Get Subscription

```bash
GET /stripe/v1/subscriptions/{subscriptionId}
```

#### Create Subscription

```bash
POST /stripe/v1/subscriptions
Content-Type: application/x-www-form-urlencoded

customer=cus_XXX&items[0][price]=price_XXX
```

#### Cancel Subscription

```bash
DELETE /stripe/v1/subscriptions/{subscriptionId}
```

### Invoices

#### List Invoices

```bash
GET /stripe/v1/invoices?limit=10&customer=cus_XXX
```

#### Get Invoice

```bash
GET /stripe/v1/invoices/{invoiceId}
```

### Charges

#### List Charges

```bash
GET /stripe/v1/charges?limit=10
```

### Payment Intents

#### Create Payment Intent

```bash
POST /stripe/v1/payment_intents
Content-Type: application/x-www-form-urlencoded

amount=1999&currency=usd&customer=cus_XXX
```

### Balance

#### Get Balance

```bash
GET /stripe/v1/balance
```

### Events

#### List Events

```bash
GET /stripe/v1/events?limit=10&type=customer.created
```

### Payment Methods

#### List Payment Methods

```bash
GET /stripe/v1/payment_methods?customer=cus_XXX&type=card
```

#### Attach Payment Method

```bash
POST /stripe/v1/payment_methods/{paymentMethodId}/attach
Content-Type: application/x-www-form-urlencoded

customer=cus_XXX
```

#### Detach Payment Method

```bash
POST /stripe/v1/payment_methods/{paymentMethodId}/detach
```

### Coupons

#### List Coupons

```bash
GET /stripe/v1/coupons?limit=10
```

#### Create Coupon

```bash
POST /stripe/v1/coupons
Content-Type: application/x-www-form-urlencoded

percent_off=25&duration=once
```

#### Delete Coupon

```bash
DELETE /stripe/v1/coupons/{couponId}
```

### Refunds

#### List Refunds

```bash
GET /stripe/v1/refunds?limit=10
```

#### Create Refund

```bash
POST /stripe/v1/refunds
Content-Type: application/x-www-form-urlencoded

charge=ch_XXX&amount=1000
```

## Notes

- Stripe API uses form-urlencoded data for POST requests
- IDs are prefixed: `cus_` (customer), `sub_` (subscription), `prod_` (product), `price_` (price), `in_` (invoice), `pi_` (payment intent)
- Amounts are in cents (1999 = $19.99)
- Use `expand[]` parameter to include related objects; for list endpoints use `expand[]=data.{field}` (e.g., `expand[]=data.customer`)
- List endpoints support pagination with `starting_after` and `ending_before`
- Delete returns `{id, deleted: true}` on success
- Products with prices cannot be deleted, only archived (`active=false`)

## Resources

- [API Overview](https://docs.stripe.com/api)
- [List Customers](https://docs.stripe.com/api/customers/list.md)
- [Get Customer](https://docs.stripe.com/api/customers/retrieve.md)
- [Create Customer](https://docs.stripe.com/api/customers/create.md)
- [Update Customer](https://docs.stripe.com/api/customers/update.md)
- [Delete Customer](https://docs.stripe.com/api/customers/delete.md)
- [Search Customers](https://docs.stripe.com/api/customers/search.md)
- [List Products](https://docs.stripe.com/api/products/list.md)
- [Get Product](https://docs.stripe.com/api/products/retrieve.md)
- [Create Product](https://docs.stripe.com/api/products/create.md)
- [Update Product](https://docs.stripe.com/api/products/update.md)
- [Delete Product](https://docs.stripe.com/api/products/delete.md)
- [Search Products](https://docs.stripe.com/api/products/search.md)
- [List Prices](https://docs.stripe.com/api/prices/list.md)
- [Get Price](https://docs.stripe.com/api/prices/retrieve.md)
- [Create Price](https://docs.stripe.com/api/prices/create.md)
- [Update Price](https://docs.stripe.com/api/prices/update.md)
- [Search Prices](https://docs.stripe.com/api/prices/search.md)
- [List Subscriptions](https://docs.stripe.com/api/subscriptions/list.md)
- [Get Subscription](https://docs.stripe.com/api/subscriptions/retrieve.md)
- [Create Subscription](https://docs.stripe.com/api/subscriptions/create.md)
- [Update Subscription](https://docs.stripe.com/api/subscriptions/update.md)
- [Cancel Subscription](https://docs.stripe.com/api/subscriptions/cancel.md)
- [Resume Subscription](https://docs.stripe.com/api/subscriptions/resume.md)
- [Search Subscriptions](https://docs.stripe.com/api/subscriptions/search.md)
- [List Invoices](https://docs.stripe.com/api/invoices/list.md)
- [Get Invoice](https://docs.stripe.com/api/invoices/retrieve.md)
- [Create Invoice](https://docs.stripe.com/api/invoices/create.md)
- [Update Invoice](https://docs.stripe.com/api/invoices/update.md)
- [Delete Invoice](https://docs.stripe.com/api/invoices/delete.md)
- [Finalize Invoice](https://docs.stripe.com/api/invoices/finalize.md)
- [Pay Invoice](https://docs.stripe.com/api/invoices/pay.md)
- [Send Invoice](https://docs.stripe.com/api/invoices/send.md)
- [Void Invoice](https://docs.stripe.com/api/invoices/void.md)
- [Search Invoices](https://docs.stripe.com/api/invoices/search.md)
- [List Charges](https://docs.stripe.com/api/charges/list.md)
- [Get Charge](https://docs.stripe.com/api/charges/retrieve.md)
- [Create Charge](https://docs.stripe.com/api/charges/create.md)
- [Update Charge](https://docs.stripe.com/api/charges/update.md)
- [Capture Charge](https://docs.stripe.com/api/charges/capture.md)
- [Search Charges](https://docs.stripe.com/api/charges/search.md)
- [List Payment Intents](https://docs.stripe.com/api/payment_intents/list.md)
- [Get Payment Intent](https://docs.stripe.com/api/payment_intents/retrieve.md)
- [Create Payment Intent](https://docs.stripe.com/api/payment_intents/create.md)
- [Update Payment Intent](https://docs.stripe.com/api/payment_intents/update.md)
- [Confirm Payment Intent](https://docs.stripe.com/api/payment_intents/confirm.md)
- [Capture Payment Intent](https://docs.stripe.com/api/payment_intents/capture.md)
- [Cancel Payment Intent](https://docs.stripe.com/api/payment_intents/cancel.md)
- [Search Payment Intents](https://docs.stripe.com/api/payment_intents/search.md)
- [Get Balance](https://docs.stripe.com/api/balance/balance_retrieve.md)
- [List Balance Transactions](https://docs.stripe.com/api/balance_transactions/list.md)
- [Get Balance Transaction](https://docs.stripe.com/api/balance_transactions/retrieve.md)
- [List Events](https://docs.stripe.com/api/events/list.md)
- [Get Event](https://docs.stripe.com/api/events/retrieve.md)
- [Pagination](https://docs.stripe.com/api/pagination.md)
- [Expanding Responses](https://docs.stripe.com/api/expanding_objects.md)
- [LLM Reference](https://docs.stripe.com/llms.txt)
