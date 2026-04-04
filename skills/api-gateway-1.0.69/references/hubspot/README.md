# HubSpot Routing Reference

**App name:** `hubspot`
**Base URL proxied:** `api.hubapi.com`

## API Path Pattern

```
/hubspot/crm/v3/objects/{objectType}/{endpoint}
```

## Common Endpoints

### Contacts

#### List Contacts

```bash
GET /hubspot/crm/v3/objects/contacts?limit=100
```

With properties:

```bash
GET /hubspot/crm/v3/objects/contacts?limit=100&properties=email,firstname,lastname,phone
```

With pagination:

```bash
GET /hubspot/crm/v3/objects/contacts?limit=100&properties=email,firstname&after={cursor}
```

#### Get Contact

```bash
GET /hubspot/crm/v3/objects/contacts/{contactId}?properties=email,firstname,lastname
```

#### Create Contact

```bash
POST /hubspot/crm/v3/objects/contacts
Content-Type: application/json

{
  "properties": {
    "email": "john@example.com",
    "firstname": "John",
    "lastname": "Doe",
    "phone": "+1234567890"
  }
}
```

#### Update Contact

```bash
PATCH /hubspot/crm/v3/objects/contacts/{contactId}
Content-Type: application/json

{
  "properties": {
    "phone": "+0987654321"
  }
}
```

#### Delete Contact

```bash
DELETE /hubspot/crm/v3/objects/contacts/{contactId}
```

#### Search Contacts

```bash
POST /hubspot/crm/v3/objects/contacts/search
Content-Type: application/json

{
  "filterGroups": [{
    "filters": [{
      "propertyName": "email",
      "operator": "EQ",
      "value": "john@example.com"
    }]
  }],
  "properties": ["email", "firstname", "lastname"]
}
```

### Companies

#### List Companies

```bash
GET /hubspot/crm/v3/objects/companies?limit=100&properties=name,domain,industry
```

#### Get Company

```bash
GET /hubspot/crm/v3/objects/companies/{companyId}?properties=name,domain,industry
```

#### Create Company

```bash
POST /hubspot/crm/v3/objects/companies
Content-Type: application/json

{
  "properties": {
    "name": "Acme Corp",
    "domain": "acme.com",
    "industry": "COMPUTER_SOFTWARE"
  }
}
```

**Note:** The `industry` property requires specific enum values (e.g., `COMPUTER_SOFTWARE`, `FINANCE`, `HEALTHCARE`), not free text like "Technology". Use the List Properties endpoint to get valid values.

#### Update Company

```bash
PATCH /hubspot/crm/v3/objects/companies/{companyId}
Content-Type: application/json

{
  "properties": {
    "industry": "COMPUTER_SOFTWARE",
    "numberofemployees": "50"
  }
}
```

#### Delete Company

```bash
DELETE /hubspot/crm/v3/objects/companies/{companyId}
```

#### Search Companies

```bash
POST /hubspot/crm/v3/objects/companies/search
Content-Type: application/json

{
  "filterGroups": [{
    "filters": [{
      "propertyName": "domain",
      "operator": "CONTAINS_TOKEN",
      "value": "*"
    }]
  }],
  "properties": ["name", "domain"],
  "limit": 10
}
```

### Deals

#### List Deals

```bash
GET /hubspot/crm/v3/objects/deals?limit=100&properties=dealname,amount,dealstage
```

#### Get Deal

```bash
GET /hubspot/crm/v3/objects/deals/{dealId}?properties=dealname,amount,dealstage
```

#### Create Deal

```bash
POST /hubspot/crm/v3/objects/deals
Content-Type: application/json

{
  "properties": {
    "dealname": "New Deal",
    "amount": "10000",
    "dealstage": "appointmentscheduled"
  }
}
```

#### Update Deal

```bash
PATCH /hubspot/crm/v3/objects/deals/{dealId}
Content-Type: application/json

{
  "properties": {
    "amount": "15000",
    "dealstage": "qualifiedtobuy"
  }
}
```

#### Delete Deal

```bash
DELETE /hubspot/crm/v3/objects/deals/{dealId}
```

#### Search Deals

```bash
POST /hubspot/crm/v3/objects/deals/search
Content-Type: application/json

{
  "filterGroups": [{
    "filters": [{
      "propertyName": "amount",
      "operator": "GTE",
      "value": "1000"
    }]
  }],
  "properties": ["dealname", "amount", "dealstage"],
  "limit": 10
}
```

### Associations (v4 API)

#### Associate Objects

```bash
PUT /hubspot/crm/v4/objects/{fromObjectType}/{fromObjectId}/associations/{toObjectType}/{toObjectId}
Content-Type: application/json

[{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 279}]
```

Common association type IDs:

- `279` - Contact to Company
- `3` - Deal to Contact
- `341` - Deal to Company

#### List Associations

```bash
GET /hubspot/crm/v4/objects/{objectType}/{objectId}/associations/{toObjectType}
```

### Batch Operations

#### Batch Read

```bash
POST /hubspot/crm/v3/objects/{objectType}/batch/read
Content-Type: application/json

{
  "properties": ["email", "firstname"],
  "inputs": [{"id": "123"}, {"id": "456"}]
}
```

#### Batch Create

```bash
POST /hubspot/crm/v3/objects/{objectType}/batch/create
Content-Type: application/json

{
  "inputs": [
    {"properties": {"email": "one@example.com", "firstname": "One"}},
    {"properties": {"email": "two@example.com", "firstname": "Two"}}
  ]
}
```

#### Batch Update

```bash
POST /hubspot/crm/v3/objects/{objectType}/batch/update
Content-Type: application/json

{
  "inputs": [
    {"id": "123", "properties": {"firstname": "Updated"}},
    {"id": "456", "properties": {"firstname": "Also Updated"}}
  ]
}
```

#### Batch Archive

```bash
POST /hubspot/crm/v3/objects/{objectType}/batch/archive
Content-Type: application/json

{
  "inputs": [{"id": "123"}, {"id": "456"}]
}
```

### Properties

#### List Properties

```bash
GET /hubspot/crm/v3/properties/{objectType}
```

## Search Operators

- `EQ` - Equal to
- `NEQ` - Not equal to
- `LT` - Less than
- `LTE` - Less than or equal to
- `GT` - Greater than
- `GTE` - Greater than or equal to
- `CONTAINS_TOKEN` - Contains token
- `NOT_CONTAINS_TOKEN` - Does not contain token

## Pagination

List endpoints return a `paging.next.after` cursor for pagination:

```json
{
  "results": [...],
  "paging": {
    "next": {
      "after": "12345",
      "link": "https://api.hubapi.com/..."
    }
  }
}
```

Use the `after` query parameter to fetch the next page:

```bash
GET /hubspot/crm/v3/objects/contacts?limit=100&after=12345
```

## Notes

- Authentication is automatic - the router injects the OAuth token
- The `industry` property on companies requires specific enum values
- Batch operations support up to 100 records per request
- Archive/Delete is a soft delete - records can be restored within 90 days
- Delete endpoints return HTTP 204 (No Content) on success

## Resources

- [API Overview](https://developers.hubspot.com/docs/api/overview)
- [List Contacts](https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/basic/get-crm-v3-objects-contacts.md)
- [Get Contact](https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/basic/get-crm-v3-objects-contacts-contactId.md)
- [Create Contact](https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/basic/post-crm-v3-objects-contacts.md)
- [Update Contact](https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/basic/patch-crm-v3-objects-contacts-contactId.md)
- [Archive Contact](https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/basic/delete-crm-v3-objects-contacts-contactId.md)
- [Merge Contacts](https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/basic/post-crm-v3-objects-contacts-merge.md)
- [GDPR Delete Contact](https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/basic/post-crm-v3-objects-contacts-gdpr-delete.md)
- [Search Contacts](https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/search/post-crm-v3-objects-contacts-search.md)
- [List Companies](https://developers.hubspot.com/docs/api-reference/crm-companies-v3/basic/get-crm-v3-objects-companies.md)
- [Get Company](https://developers.hubspot.com/docs/api-reference/crm-companies-v3/basic/get-crm-v3-objects-companies-companyId.md)
- [Create Company](https://developers.hubspot.com/docs/api-reference/crm-companies-v3/basic/post-crm-v3-objects-companies.md)
- [Update Company](https://developers.hubspot.com/docs/api-reference/crm-companies-v3/basic/patch-crm-v3-objects-companies-companyId.md)
- [Archive Company](https://developers.hubspot.com/docs/api-reference/crm-companies-v3/basic/delete-crm-v3-objects-companies-companyId.md)
- [Merge Companies](https://developers.hubspot.com/docs/api-reference/crm-companies-v3/basic/post-crm-v3-objects-companies-merge.md)
- [Search Companies](https://developers.hubspot.com/docs/api-reference/crm-companies-v3/search/post-crm-v3-objects-companies-search.md)
- [List Deals](https://developers.hubspot.com/docs/api-reference/crm-deals-v3/basic/get-crm-v3-objects-0-3.md)
- [Get Deal](https://developers.hubspot.com/docs/api-reference/crm-deals-v3/basic/get-crm-v3-objects-0-3-dealId.md)
- [Create Deal](https://developers.hubspot.com/docs/api-reference/crm-deals-v3/basic/post-crm-v3-objects-0-3.md)
- [Update Deal](https://developers.hubspot.com/docs/api-reference/crm-deals-v3/basic/patch-crm-v3-objects-0-3-dealId.md)
- [Archive Deal](https://developers.hubspot.com/docs/api-reference/crm-deals-v3/basic/delete-crm-v3-objects-0-3-dealId.md)
- [Merge Deals](https://developers.hubspot.com/docs/api-reference/crm-deals-v3/basic/post-crm-v3-objects-0-3-merge.md)
- [Search Deals](https://developers.hubspot.com/docs/api-reference/crm-deals-v3/search/post-crm-v3-objects-0-3-search.md)
- [List Associations](https://developers.hubspot.com/docs/api-reference/crm-associations-v4/basic/get-crm-v4-objects-objectType-objectId-associations-toObjectType.md)
- [Create Association](https://developers.hubspot.com/docs/api-reference/crm-associations-v4/basic/put-crm-v4-objects-objectType-objectId-associations-toObjectType-toObjectId.md)
- [Delete Association](https://developers.hubspot.com/docs/api-reference/crm-associations-v4/basic/delete-crm-v4-objects-objectType-objectId-associations-toObjectType-toObjectId.md)
- [List Properties](https://developers.hubspot.com/docs/api-reference/crm-properties-v3/core/get-crm-v3-properties-objectType.md)
- [Get Property](https://developers.hubspot.com/docs/api-reference/crm-properties-v3/core/get-crm-v3-properties-objectType-propertyName.md)
- [Create Property](https://developers.hubspot.com/docs/api-reference/crm-properties-v3/core/post-crm-v3-properties-objectType.md)
- [Search Reference](https://developers.hubspot.com/docs/api/crm/search)
