# QuickBooks Routing Reference

**App name:** `quickbooks`
**Base URL proxied:** `quickbooks.api.intuit.com`

## Special Handling

Use `:realmId` in the path and it will be automatically replaced with the connected company's realm ID.

## API Path Pattern

```
/quickbooks/v3/company/:realmId/{endpoint}
```

## Common Endpoints

### Company Info

#### Get Company Info

```bash
GET /quickbooks/v3/company/:realmId/companyinfo/:realmId
```

#### Get Preferences

```bash
GET /quickbooks/v3/company/:realmId/preferences
```

### Customers

#### Query Customers

```bash
GET /quickbooks/v3/company/:realmId/query?query=SELECT%20*%20FROM%20Customer%20MAXRESULTS%20100
```

With filter:

```bash
GET /quickbooks/v3/company/:realmId/query?query=SELECT%20*%20FROM%20Customer%20WHERE%20Active%3Dtrue
```

#### Get Customer

```bash
GET /quickbooks/v3/company/:realmId/customer/{customerId}
```

#### Create Customer

```bash
POST /quickbooks/v3/company/:realmId/customer
Content-Type: application/json

{
  "DisplayName": "John Doe",
  "PrimaryEmailAddr": {"Address": "john@example.com"},
  "PrimaryPhone": {"FreeFormNumber": "555-1234"}
}
```

#### Update Customer

Requires `Id` and `SyncToken` from previous GET:

```bash
POST /quickbooks/v3/company/:realmId/customer
Content-Type: application/json

{
  "Id": "123",
  "SyncToken": "0",
  "DisplayName": "John Doe Updated",
  "PrimaryPhone": {"FreeFormNumber": "555-9999"}
}
```

#### Deactivate Customer (Soft Delete)

```bash
POST /quickbooks/v3/company/:realmId/customer
Content-Type: application/json

{
  "Id": "123",
  "SyncToken": "1",
  "DisplayName": "John Doe",
  "Active": false
}
```

### Vendors

#### Query Vendors

```bash
GET /quickbooks/v3/company/:realmId/query?query=SELECT%20*%20FROM%20Vendor%20MAXRESULTS%20100
```

#### Get Vendor

```bash
GET /quickbooks/v3/company/:realmId/vendor/{vendorId}
```

#### Create Vendor

```bash
POST /quickbooks/v3/company/:realmId/vendor
Content-Type: application/json

{
  "DisplayName": "Acme Supplies",
  "PrimaryEmailAddr": {"Address": "vendor@example.com"}
}
```

### Items (Products/Services)

#### Query Items

```bash
GET /quickbooks/v3/company/:realmId/query?query=SELECT%20*%20FROM%20Item%20MAXRESULTS%20100
```

#### Get Item

```bash
GET /quickbooks/v3/company/:realmId/item/{itemId}
```

#### Create Item

```bash
POST /quickbooks/v3/company/:realmId/item
Content-Type: application/json

{
  "Name": "Consulting Services",
  "Type": "Service",
  "IncomeAccountRef": {"value": "1"}
}
```

### Invoices

#### Query Invoices

```bash
GET /quickbooks/v3/company/:realmId/query?query=SELECT%20*%20FROM%20Invoice%20MAXRESULTS%20100
```

#### Get Invoice

```bash
GET /quickbooks/v3/company/:realmId/invoice/{invoiceId}
```

#### Create Invoice

```bash
POST /quickbooks/v3/company/:realmId/invoice
Content-Type: application/json

{
  "CustomerRef": {"value": "123"},
  "Line": [
    {
      "Amount": 100.00,
      "DetailType": "SalesItemLineDetail",
      "SalesItemLineDetail": {
        "ItemRef": {"value": "1"},
        "Qty": 1
      }
    }
  ]
}
```

#### Void Invoice

```bash
POST /quickbooks/v3/company/:realmId/invoice?operation=void
Content-Type: application/json

{
  "Id": "123",
  "SyncToken": "0"
}
```

#### Delete Invoice

```bash
POST /quickbooks/v3/company/:realmId/invoice?operation=delete
Content-Type: application/json

{
  "Id": "123",
  "SyncToken": "0"
}
```

### Payments

#### Query Payments

```bash
GET /quickbooks/v3/company/:realmId/query?query=SELECT%20*%20FROM%20Payment%20MAXRESULTS%20100
```

#### Create Payment

Simple payment:

```bash
POST /quickbooks/v3/company/:realmId/payment
Content-Type: application/json

{
  "CustomerRef": {"value": "123"},
  "TotalAmt": 100.00
}
```

Payment linked to invoice:

```bash
POST /quickbooks/v3/company/:realmId/payment
Content-Type: application/json

{
  "CustomerRef": {"value": "123"},
  "TotalAmt": 100.00,
  "Line": [
    {
      "Amount": 100.00,
      "LinkedTxn": [{"TxnId": "456", "TxnType": "Invoice"}]
    }
  ]
}
```

### Bills

#### Query Bills

```bash
GET /quickbooks/v3/company/:realmId/query?query=SELECT%20*%20FROM%20Bill%20MAXRESULTS%20100
```

#### Create Bill

```bash
POST /quickbooks/v3/company/:realmId/bill
Content-Type: application/json

{
  "VendorRef": {"value": "123"},
  "Line": [
    {
      "DetailType": "AccountBasedExpenseLineDetail",
      "Amount": 250.00,
      "AccountBasedExpenseLineDetail": {
        "AccountRef": {"value": "1"}
      }
    }
  ]
}
```

### Bill Payments

#### Create Bill Payment

```bash
POST /quickbooks/v3/company/:realmId/billpayment
Content-Type: application/json

{
  "VendorRef": {"value": "123"},
  "TotalAmt": 250.00,
  "PayType": "Check",
  "CheckPayment": {
    "BankAccountRef": {"value": "23"}
  },
  "Line": [
    {
      "Amount": 250.00,
      "LinkedTxn": [{"TxnId": "456", "TxnType": "Bill"}]
    }
  ]
}
```

**Note:** Use a Bank account (AccountType: "Bank") for `BankAccountRef`.

### Accounts

#### Query Accounts

```bash
GET /quickbooks/v3/company/:realmId/query?query=SELECT%20*%20FROM%20Account
```

Filter by type:

```bash
GET /quickbooks/v3/company/:realmId/query?query=SELECT%20*%20FROM%20Account%20WHERE%20AccountType%20%3D%20%27Bank%27
```

### Reports

#### Profit and Loss

```bash
GET /quickbooks/v3/company/:realmId/reports/ProfitAndLoss?start_date=2024-01-01&end_date=2024-12-31
```

#### Balance Sheet

```bash
GET /quickbooks/v3/company/:realmId/reports/BalanceSheet?date=2024-12-31
```

### Batch Operations

Execute multiple queries in a single request:

```bash
POST /quickbooks/v3/company/:realmId/batch
Content-Type: application/json

{
  "BatchItemRequest": [
    {"bId": "1", "Query": "SELECT * FROM Customer MAXRESULTS 2"},
    {"bId": "2", "Query": "SELECT * FROM Vendor MAXRESULTS 2"}
  ]
}
```

## Query Language

QuickBooks uses a SQL-like query language:

```sql
SELECT * FROM Customer WHERE DisplayName LIKE 'John%' MAXRESULTS 100
```

Operators: `=`, `LIKE`, `<`, `>`, `<=`, `>=`, `IN`

## SyncToken for Updates

All update operations require the current `SyncToken` from the entity. The SyncToken is incremented after each successful update.

1. GET the entity to retrieve current `SyncToken`
2. Include `Id` and `SyncToken` in the POST body
3. If the SyncToken doesn't match, the update fails (optimistic locking)

## Void vs Delete

- **Void**: Sets transaction amount to 0, adds "Voided" note, keeps record. Use for audit trail.
- **Delete**: Permanently removes the transaction. Use `?operation=delete` query parameter.

Both require `Id` and `SyncToken` in the request body.

## Notes

- `:realmId` is automatically replaced by the router
- All queries must be URL-encoded
- Use `MAXRESULTS` to limit query results (default varies by entity)
- Include `SyncToken` when updating entities (for optimistic locking)
- Dates are in `YYYY-MM-DD` format
- Soft delete entities (Customer, Vendor, Item) by setting `Active: false`
- Transactions (Invoice, Payment, Bill) can be voided or deleted

## Resources

- [API Overview](https://developer.intuit.com/app/developer/qbo/docs/get-started)
- [Query Customers](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/customer#query-a-customer)
- [Get Customer](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/customer#read-a-customer)
- [Create Customer](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/customer#create-a-customer)
- [Update Customer](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/customer#full-update-a-customer)
- [Query Invoices](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice#query-an-invoice)
- [Get Invoice](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice#read-an-invoice)
- [Create Invoice](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice#create-an-invoice)
- [Update Invoice](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice#full-update-an-invoice)
- [Delete Invoice](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice#delete-an-invoice)
- [Send Invoice](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice#send-an-invoice)
- [Query Items](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/item#query-an-item)
- [Get Item](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/item#read-an-item)
- [Create Item](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/item#create-an-item)
- [Update Item](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/item#full-update-an-item)
- [Query Accounts](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/account#query-an-account)
- [Get Account](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/account#read-an-account)
- [Create Account](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/account#create-an-account)
- [Update Account](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/account#full-update-an-account)
- [Query Payments](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/payment#query-a-payment)
- [Get Payment](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/payment#read-a-payment)
- [Create Payment](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/payment#create-a-payment)
- [Update Payment](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/payment#full-update-a-payment)
- [Delete Payment](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/payment#delete-a-payment)
- [Query Vendors](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/vendor#query-a-vendor)
- [Get Vendor](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/vendor#read-a-vendor)
- [Create Vendor](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/vendor#create-a-vendor)
- [Update Vendor](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/vendor#full-update-a-vendor)
- [Query Bills](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/bill#query-a-bill)
- [Get Bill](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/bill#read-a-bill)
- [Create Bill](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/bill#create-a-bill)
- [Update Bill](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/bill#full-update-a-bill)
- [Delete Bill](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/bill#delete-a-bill)
- [Profit and Loss Report](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/report-entities/profitandloss)
- [Balance Sheet Report](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/report-entities/balancesheet)
- [Query Reference](https://developer.intuit.com/app/developer/qbdesktop/docs/develop/exploring-the-quickbooks-desktop-sdk/query-requests-and-responses)
