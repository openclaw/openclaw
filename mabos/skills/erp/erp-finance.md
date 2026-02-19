# ERP Finance Tools

## Tool: `erp_finance`

Manage invoicing, payments, general ledger, and profit-and-loss reporting. Handles multi-currency transactions and double-entry bookkeeping.

## Actions

### `create_invoice`

Create a new invoice for a customer.

**Parameters:**

- `customer_id` (required) - Customer to bill
- `line_items` (optional) - Array of {description, quantity, unit_price}
- `due_date` (optional) - Payment due date (ISO 8601)
- `currency` (optional) - Currency code (default: USD)

**Example:**

```json
{
  "action": "create_invoice",
  "params": {
    "customer_id": "cust_001",
    "line_items": [{ "description": "Consulting hours", "quantity": 10, "unit_price": 150 }],
    "due_date": "2026-03-15",
    "currency": "USD"
  }
}
```

### `get_invoice`

Retrieve an invoice by ID.

**Parameters:**

- `id` (required) - Invoice ID

### `list_invoices`

List invoices with optional filters.

**Parameters:**

- `status` (optional) - Filter by status (draft, sent, paid, overdue)
- `customer_id` (optional) - Filter by customer
- `limit` (optional) - Max results

### `record_payment`

Record a payment against an invoice.

**Parameters:**

- `invoice_id` (required) - Invoice being paid
- `amount` (required) - Payment amount
- `method` (optional) - Payment method (card, bank_transfer, cash, check)

**Example:**

```json
{
  "action": "record_payment",
  "params": { "invoice_id": "inv_042", "amount": 1500.0, "method": "bank_transfer" }
}
```

### `get_balance`

Get current balance for a ledger account.

**Parameters:**

- `account_id` (required) - Ledger account ID

### `profit_loss`

Generate a profit-and-loss report for a date range.

**Parameters:**

- `from` (required) - Start date (ISO 8601)
- `to` (required) - End date (ISO 8601)

**Example:**

```json
{ "action": "profit_loss", "params": { "from": "2026-01-01", "to": "2026-01-31" } }
```

### `create_account`

Create a new ledger account.

**Parameters:**

- `name` (required) - Account name
- `type` (required) - Account type (asset, liability, equity, revenue, expense)
- `currency` (optional) - Currency code

### `post_ledger_entry`

Post a journal entry to the general ledger.

**Parameters:**

- `account_id` or `debit_account`/`credit_account` (required) - Account(s)
- `amount` (required) - Entry amount
- `description` (optional) - Entry description

## Tips

- Always check for overdue invoices regularly with `list_invoices` status=overdue.
- Use `profit_loss` at month-end to generate financial summaries.
- Record payments promptly so balances stay accurate.
- Prefer double-entry (debit_account/credit_account) for audit-ready bookkeeping.
