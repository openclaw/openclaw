# Airtable Routing Reference

**App name:** `airtable`
**Base URL proxied:** `api.airtable.com`

## API Path Pattern

```
/airtable/v0/{baseId}/{tableIdOrName}
```

## Common Endpoints

### List Records

```bash
GET /airtable/v0/{baseId}/{tableIdOrName}?maxRecords=100
```

With view:

```bash
GET /airtable/v0/{baseId}/{tableIdOrName}?view=Grid%20view&maxRecords=100
```

With filter formula:

```bash
GET /airtable/v0/{baseId}/{tableIdOrName}?filterByFormula={Status}='Active'
```

With field selection:

```bash
GET /airtable/v0/{baseId}/{tableIdOrName}?fields[]=Name&fields[]=Status&fields[]=Email
```

With sorting:

```bash
GET /airtable/v0/{baseId}/{tableIdOrName}?sort[0][field]=Created&sort[0][direction]=desc
```

### Get Record

```bash
GET /airtable/v0/{baseId}/{tableIdOrName}/{recordId}
```

### Create Records

```bash
POST /airtable/v0/{baseId}/{tableIdOrName}
Content-Type: application/json

{
  "records": [
    {
      "fields": {
        "Name": "New Record",
        "Status": "Active",
        "Email": "test@example.com"
      }
    }
  ]
}
```

### Update Records (PATCH - partial update)

```bash
PATCH /airtable/v0/{baseId}/{tableIdOrName}
Content-Type: application/json

{
  "records": [
    {
      "id": "recXXXXXXXXXXXXXX",
      "fields": {
        "Status": "Completed"
      }
    }
  ]
}
```

### Update Records (PUT - full replace)

```bash
PUT /airtable/v0/{baseId}/{tableIdOrName}
Content-Type: application/json

{
  "records": [
    {
      "id": "recXXXXXXXXXXXXXX",
      "fields": {
        "Name": "Updated Name",
        "Status": "Active"
      }
    }
  ]
}
```

### Delete Records

```bash
DELETE /airtable/v0/{baseId}/{tableIdOrName}?records[]=recXXXXX&records[]=recYYYYY
```

### List Bases

```bash
GET /airtable/v0/meta/bases
```

### Get Base Schema

```bash
GET /airtable/v0/meta/bases/{baseId}/tables
```

## Pagination

**Parameters:**

- `pageSize` - Number of records per request (max 100, default 100)
- `maxRecords` - Maximum total records across all pages
- `offset` - Cursor for next page (returned in response)

Response includes `offset` when more records exist:

```json
{
  "records": [...],
  "offset": "itrXXXXXXXXXXX"
}
```

Use offset for next page:

```bash
GET /airtable/v0/{baseId}/{tableIdOrName}?pageSize=50&offset=itrXXXXXXXXXXX
```

## Notes

- Authentication is automatic via OAuth
- Base IDs start with `app`
- Table IDs start with `tbl` (can also use table name)
- Record IDs start with `rec`
- Maximum 100 records per request for create/update
- Maximum 10 records per delete request
- Filter formulas use Airtable formula syntax

## Resources

- [API Overview](https://airtable.com/developers/web/api/introduction)
- [List Records](https://airtable.com/developers/web/api/list-records)
- [Create Records](https://airtable.com/developers/web/api/create-records)
- [Update Records](https://airtable.com/developers/web/api/update-record)
- [Delete Records](https://airtable.com/developers/web/api/delete-record)
- [Formula Reference](https://support.airtable.com/docs/formula-field-reference)
