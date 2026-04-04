# Zoho Books Routing Reference

**App name:** `zoho-books`
**Base URL proxied:** `www.zohoapis.com`

## API Path Pattern

```
/zoho-books/books/v3/{resource}
```

## Common Endpoints

### Contacts

```bash
# List contacts
GET /zoho-books/books/v3/contacts

# Get contact
GET /zoho-books/books/v3/contacts/{contact_id}

# Create contact
POST /zoho-books/books/v3/contacts
Content-Type: application/json

{
  "contact_name": "Customer Name",
  "contact_type": "customer"
}

# Update contact
PUT /zoho-books/books/v3/contacts/{contact_id}

# Delete contact
DELETE /zoho-books/books/v3/contacts/{contact_id}
```

### Invoices

```bash
# List invoices
GET /zoho-books/books/v3/invoices

# Get invoice
GET /zoho-books/books/v3/invoices/{invoice_id}

# Create invoice
POST /zoho-books/books/v3/invoices

# Mark as sent
POST /zoho-books/books/v3/invoices/{invoice_id}/status/sent

# Email invoice
POST /zoho-books/books/v3/invoices/{invoice_id}/email
```

### Bills

```bash
# List bills
GET /zoho-books/books/v3/bills

# Create bill
POST /zoho-books/books/v3/bills

# Update bill
PUT /zoho-books/books/v3/bills/{bill_id}

# Delete bill
DELETE /zoho-books/books/v3/bills/{bill_id}
```

### Expenses

```bash
# List expenses
GET /zoho-books/books/v3/expenses

# Create expense
POST /zoho-books/books/v3/expenses

# Update expense
PUT /zoho-books/books/v3/expenses/{expense_id}

# Delete expense
DELETE /zoho-books/books/v3/expenses/{expense_id}
```

### Sales Orders

```bash
GET /zoho-books/books/v3/salesorders
POST /zoho-books/books/v3/salesorders
```

### Purchase Orders

```bash
GET /zoho-books/books/v3/purchaseorders
POST /zoho-books/books/v3/purchaseorders
```

### Credit Notes

```bash
GET /zoho-books/books/v3/creditnotes
```

### Recurring Invoices

```bash
GET /zoho-books/books/v3/recurringinvoices
```

### Recurring Bills

```bash
GET /zoho-books/books/v3/recurringbills
```

## Available Modules

| Module             | Endpoint             | Description           |
| ------------------ | -------------------- | --------------------- |
| Contacts           | `/contacts`          | Customers and vendors |
| Invoices           | `/invoices`          | Sales invoices        |
| Bills              | `/bills`             | Vendor bills          |
| Expenses           | `/expenses`          | Business expenses     |
| Sales Orders       | `/salesorders`       | Sales orders          |
| Purchase Orders    | `/purchaseorders`    | Purchase orders       |
| Credit Notes       | `/creditnotes`       | Customer credit notes |
| Recurring Invoices | `/recurringinvoices` | Recurring invoices    |
| Recurring Bills    | `/recurringbills`    | Recurring bills       |

## Notes

- All successful responses have `code: 0`
- Dates should be in `yyyy-mm-dd` format
- Contact types are `customer` or `vendor`
- Some modules (items, chart of accounts, bank accounts, projects) require additional OAuth scopes
- Rate limits: 100 requests/minute per organization
- Pagination uses `page` and `per_page` parameters with `has_more_page` in response

## Resources

- [Zoho Books API v3 Introduction](https://www.zoho.com/books/api/v3/introduction/)
- [Zoho Books Invoices API](https://www.zoho.com/books/api/v3/invoices/)
- [Zoho Books Contacts API](https://www.zoho.com/books/api/v3/contacts/)
- [Zoho Books Bills API](https://www.zoho.com/books/api/v3/bills/)
- [Zoho Books Expenses API](https://www.zoho.com/books/api/v3/expenses/)
