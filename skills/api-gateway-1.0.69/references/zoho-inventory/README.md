# Zoho Inventory Routing Reference

**App name:** `zoho-inventory`
**Base URL proxied:** `www.zohoapis.com`

## API Path Pattern

```
/zoho-inventory/inventory/v1/{resource}
```

## Common Endpoints

### Items

```bash
# List items
GET /zoho-inventory/inventory/v1/items

# Get item
GET /zoho-inventory/inventory/v1/items/{item_id}

# Create item
POST /zoho-inventory/inventory/v1/items
Content-Type: application/json

{
  "name": "Widget",
  "rate": 25.00,
  "purchase_rate": 10.00,
  "sku": "WDG-001",
  "item_type": "inventory",
  "product_type": "goods",
  "unit": "pcs"
}

# Update item
PUT /zoho-inventory/inventory/v1/items/{item_id}

# Delete item
DELETE /zoho-inventory/inventory/v1/items/{item_id}

# Mark as active/inactive
POST /zoho-inventory/inventory/v1/items/{item_id}/active
POST /zoho-inventory/inventory/v1/items/{item_id}/inactive
```

### Contacts

```bash
# List contacts
GET /zoho-inventory/inventory/v1/contacts

# Get contact
GET /zoho-inventory/inventory/v1/contacts/{contact_id}

# Create contact
POST /zoho-inventory/inventory/v1/contacts
Content-Type: application/json

{
  "contact_name": "Customer Name",
  "contact_type": "customer"
}

# Update contact
PUT /zoho-inventory/inventory/v1/contacts/{contact_id}

# Delete contact
DELETE /zoho-inventory/inventory/v1/contacts/{contact_id}
```

### Sales Orders

```bash
# List sales orders
GET /zoho-inventory/inventory/v1/salesorders

# Get sales order
GET /zoho-inventory/inventory/v1/salesorders/{salesorder_id}

# Create sales order
POST /zoho-inventory/inventory/v1/salesorders

# Update sales order
PUT /zoho-inventory/inventory/v1/salesorders/{salesorder_id}

# Delete sales order
DELETE /zoho-inventory/inventory/v1/salesorders/{salesorder_id}

# Status actions
POST /zoho-inventory/inventory/v1/salesorders/{salesorder_id}/status/confirmed
POST /zoho-inventory/inventory/v1/salesorders/{salesorder_id}/status/void
```

### Invoices

```bash
# List invoices
GET /zoho-inventory/inventory/v1/invoices

# Get invoice
GET /zoho-inventory/inventory/v1/invoices/{invoice_id}

# Create invoice
POST /zoho-inventory/inventory/v1/invoices

# Update invoice
PUT /zoho-inventory/inventory/v1/invoices/{invoice_id}

# Delete invoice
DELETE /zoho-inventory/inventory/v1/invoices/{invoice_id}

# Status actions
POST /zoho-inventory/inventory/v1/invoices/{invoice_id}/status/sent
POST /zoho-inventory/inventory/v1/invoices/{invoice_id}/status/draft
POST /zoho-inventory/inventory/v1/invoices/{invoice_id}/status/void

# Email
POST /zoho-inventory/inventory/v1/invoices/{invoice_id}/email
```

### Purchase Orders

```bash
# List purchase orders
GET /zoho-inventory/inventory/v1/purchaseorders

# Create purchase order
POST /zoho-inventory/inventory/v1/purchaseorders

# Update purchase order
PUT /zoho-inventory/inventory/v1/purchaseorders/{purchaseorder_id}

# Delete purchase order
DELETE /zoho-inventory/inventory/v1/purchaseorders/{purchaseorder_id}

# Status actions
POST /zoho-inventory/inventory/v1/purchaseorders/{purchaseorder_id}/status/issued
POST /zoho-inventory/inventory/v1/purchaseorders/{purchaseorder_id}/status/cancelled
```

### Bills

```bash
# List bills
GET /zoho-inventory/inventory/v1/bills

# Create bill
POST /zoho-inventory/inventory/v1/bills

# Update bill
PUT /zoho-inventory/inventory/v1/bills/{bill_id}

# Delete bill
DELETE /zoho-inventory/inventory/v1/bills/{bill_id}

# Status actions
POST /zoho-inventory/inventory/v1/bills/{bill_id}/status/open
POST /zoho-inventory/inventory/v1/bills/{bill_id}/status/void
```

### Item Groups

```bash
GET /zoho-inventory/inventory/v1/itemgroups
GET /zoho-inventory/inventory/v1/itemgroups/{itemgroup_id}
POST /zoho-inventory/inventory/v1/itemgroups
PUT /zoho-inventory/inventory/v1/itemgroups/{itemgroup_id}
DELETE /zoho-inventory/inventory/v1/itemgroups/{itemgroup_id}
```

### Shipment Orders

```bash
POST /zoho-inventory/inventory/v1/shipmentorders
GET /zoho-inventory/inventory/v1/shipmentorders/{shipmentorder_id}
PUT /zoho-inventory/inventory/v1/shipmentorders/{shipmentorder_id}
DELETE /zoho-inventory/inventory/v1/shipmentorders/{shipmentorder_id}
POST /zoho-inventory/inventory/v1/shipmentorders/{shipmentorder_id}/status/delivered
```

## Available Modules

| Module          | Endpoint          | Description              |
| --------------- | ----------------- | ------------------------ |
| Items           | `/items`          | Products and services    |
| Item Groups     | `/itemgroups`     | Grouped product variants |
| Contacts        | `/contacts`       | Customers and vendors    |
| Sales Orders    | `/salesorders`    | Sales orders             |
| Invoices        | `/invoices`       | Sales invoices           |
| Purchase Orders | `/purchaseorders` | Purchase orders          |
| Bills           | `/bills`          | Vendor bills             |
| Shipment Orders | `/shipmentorders` | Shipment tracking        |

## Notes

- All successful responses have `code: 0`
- Dates should be in `yyyy-mm-dd` format
- Contact types are `customer` or `vendor`
- The `organization_id` parameter is automatically handled by the gateway
- Sales order and purchase order numbers are auto-generated by default
- Pagination uses `page` and `per_page` parameters with `has_more_page` in response
- Rate limits: 100 requests/minute per organization

## Resources

- [Zoho Inventory API v1 Introduction](https://www.zoho.com/inventory/api/v1/introduction/)
- [Zoho Inventory Items API](https://www.zoho.com/inventory/api/v1/items/)
- [Zoho Inventory Contacts API](https://www.zoho.com/inventory/api/v1/contacts/)
- [Zoho Inventory Sales Orders API](https://www.zoho.com/inventory/api/v1/salesorders/)
- [Zoho Inventory Invoices API](https://www.zoho.com/inventory/api/v1/invoices/)
- [Zoho Inventory Purchase Orders API](https://www.zoho.com/inventory/api/v1/purchaseorders/)
- [Zoho Inventory Bills API](https://www.zoho.com/inventory/api/v1/bills/)
