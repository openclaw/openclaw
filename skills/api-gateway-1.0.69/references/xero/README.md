# Xero Routing Reference

**App name:** `xero`
**Base URL proxied:** `api.xero.com`

## Automatic Tenant ID Injection

The router automatically injects the `Xero-Tenant-Id` header from your connection config. You do not need to provide it manually.

## API Path Pattern

```
/xero/api.xro/2.0/{endpoint}
```

## Common Endpoints

### Contacts

#### List Contacts

```bash
GET /xero/api.xro/2.0/Contacts
```

#### Get Contact

```bash
GET /xero/api.xro/2.0/Contacts/{contactId}
```

#### Create Contact

```bash
POST /xero/api.xro/2.0/Contacts
Content-Type: application/json

{
  "Contacts": [{
    "Name": "John Doe",
    "EmailAddress": "john@example.com",
    "Phones": [{"PhoneType": "DEFAULT", "PhoneNumber": "555-1234"}]
  }]
}
```

### Invoices

#### List Invoices

```bash
GET /xero/api.xro/2.0/Invoices
```

#### Get Invoice

```bash
GET /xero/api.xro/2.0/Invoices/{invoiceId}
```

#### Create Invoice

```bash
POST /xero/api.xro/2.0/Invoices
Content-Type: application/json

{
  "Invoices": [{
    "Type": "ACCREC",
    "Contact": {"ContactID": "xxx"},
    "LineItems": [{
      "Description": "Service",
      "Quantity": 1,
      "UnitAmount": 100.00,
      "AccountCode": "200"
    }]
  }]
}
```

### Accounts

#### List Accounts

```bash
GET /xero/api.xro/2.0/Accounts
```

### Items

#### List Items

```bash
GET /xero/api.xro/2.0/Items
```

### Payments

#### List Payments

```bash
GET /xero/api.xro/2.0/Payments
```

### Bank Transactions

#### List Bank Transactions

```bash
GET /xero/api.xro/2.0/BankTransactions
```

### Reports

#### Profit and Loss

```bash
GET /xero/api.xro/2.0/Reports/ProfitAndLoss?fromDate=2024-01-01&toDate=2024-12-31
```

#### Balance Sheet

```bash
GET /xero/api.xro/2.0/Reports/BalanceSheet?date=2024-12-31
```

#### Trial Balance

```bash
GET /xero/api.xro/2.0/Reports/TrialBalance?date=2024-12-31
```

### Currencies

#### List Currencies

```bash
GET /xero/api.xro/2.0/Currencies
```

### Tax Rates

#### List Tax Rates

```bash
GET /xero/api.xro/2.0/TaxRates
```

### Credit Notes

#### List Credit Notes

```bash
GET /xero/api.xro/2.0/CreditNotes
```

### Purchase Orders

#### List Purchase Orders

```bash
GET /xero/api.xro/2.0/PurchaseOrders
```

### Organisation

#### Get Organisation

```bash
GET /xero/api.xro/2.0/Organisation
```

## Invoice Types

- `ACCREC` - Accounts Receivable (sales invoice)
- `ACCPAY` - Accounts Payable (bill)

## Notes

- `Xero-Tenant-Id` header is automatically injected by the router
- Dates are in `YYYY-MM-DD` format
- Multiple records can be created in a single request using arrays
- Updates use POST method with the record ID in the URL
- Draft invoices can be deleted by setting `Status` to `DELETED`
- Use `where` query parameter for filtering (e.g., `where=Status=="VOIDED"`)

## Resources

- [API Overview](https://developer.xero.com/documentation/api/accounting/overview)
- [List Contacts](https://developer.xero.com/documentation/api/accounting/contacts#get-contacts)
- [Get Contact](https://developer.xero.com/documentation/api/accounting/contacts#get-contacts)
- [Create Contact](https://developer.xero.com/documentation/api/accounting/contacts#put-contacts)
- [Update Contact](https://developer.xero.com/documentation/api/accounting/contacts#post-contacts)
- [List Invoices](https://developer.xero.com/documentation/api/accounting/invoices#get-invoices)
- [Get Invoice](https://developer.xero.com/documentation/api/accounting/invoices#get-invoices)
- [Create Invoice](https://developer.xero.com/documentation/api/accounting/invoices#put-invoices)
- [Update Invoice](https://developer.xero.com/documentation/api/accounting/invoices#post-invoices)
- [Email Invoice](https://developer.xero.com/documentation/api/accounting/invoices#emailing-an-invoice)
- [List Accounts](https://developer.xero.com/documentation/api/accounting/accounts#get-accounts)
- [Get Account](https://developer.xero.com/documentation/api/accounting/accounts#get-accounts)
- [Create Account](https://developer.xero.com/documentation/api/accounting/accounts#put-accounts)
- [Update Account](https://developer.xero.com/documentation/api/accounting/accounts#post-accounts)
- [Delete Account](https://developer.xero.com/documentation/api/accounting/accounts#delete-accounts)
- [List Items](https://developer.xero.com/documentation/api/accounting/items#get-items)
- [Get Item](https://developer.xero.com/documentation/api/accounting/items#get-items)
- [Create Item](https://developer.xero.com/documentation/api/accounting/items#put-items)
- [Update Item](https://developer.xero.com/documentation/api/accounting/items#post-items)
- [Delete Item](https://developer.xero.com/documentation/api/accounting/items#delete-items)
- [List Payments](https://developer.xero.com/documentation/api/accounting/payments#get-payments)
- [Get Payment](https://developer.xero.com/documentation/api/accounting/payments#get-payments)
- [Create Payment](https://developer.xero.com/documentation/api/accounting/payments#put-payments)
- [Update Payment](https://developer.xero.com/documentation/api/accounting/payments#post-payments)
- [List Bank Transactions](https://developer.xero.com/documentation/api/accounting/banktransactions#get-banktransactions)
- [Get Bank Transaction](https://developer.xero.com/documentation/api/accounting/banktransactions#get-banktransactions)
- [Create Bank Transaction](https://developer.xero.com/documentation/api/accounting/banktransactions#put-banktransactions)
- [Update Bank Transaction](https://developer.xero.com/documentation/api/accounting/banktransactions#post-banktransactions)
- [Profit and Loss Report](https://developer.xero.com/documentation/api/accounting/reports#profitandloss)
- [Balance Sheet Report](https://developer.xero.com/documentation/api/accounting/reports#balancesheet)
- [Trial Balance Report](https://developer.xero.com/documentation/api/accounting/reports#trialbalance)
- [Bank Summary Report](https://developer.xero.com/documentation/api/accounting/reports#banksummary)
- [Get Organisation](https://developer.xero.com/documentation/api/accounting/organisation#get-organisation)
