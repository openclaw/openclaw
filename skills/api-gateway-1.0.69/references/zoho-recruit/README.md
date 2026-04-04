# Zoho Recruit Routing Reference

**App name:** `zoho-recruit`
**Base URL proxied:** `recruit.zoho.com`

## API Path Pattern

```
/zoho-recruit/recruit/v2/{module_api_name}
```

## Common Endpoints

### Modules

```bash
# List all modules
GET /zoho-recruit/recruit/v2/settings/modules

# Get specific module
GET /zoho-recruit/recruit/v2/settings/modules/{module_api_name}
```

### Records

```bash
# List records
GET /zoho-recruit/recruit/v2/{module_api_name}?page=1&per_page=200

# Get single record
GET /zoho-recruit/recruit/v2/{module_api_name}/{record_id}

# Create records (max 100)
POST /zoho-recruit/recruit/v2/{module_api_name}
Content-Type: application/json

{
  "data": [
    {"field_api_name": "value"}
  ]
}

# Update single record
PUT /zoho-recruit/recruit/v2/{module_api_name}/{record_id}
Content-Type: application/json

{
  "data": [
    {"field_api_name": "new_value"}
  ]
}

# Update multiple records (max 100)
PUT /zoho-recruit/recruit/v2/{module_api_name}
Content-Type: application/json

{
  "data": [
    {"id": "record_id", "field_api_name": "value"}
  ]
}

# Delete records (max 100)
DELETE /zoho-recruit/recruit/v2/{module_api_name}?ids={id1},{id2}
```

### Search

```bash
# Search by criteria
GET /zoho-recruit/recruit/v2/{module_api_name}/search?criteria=(field:operator:value)

# Search by email
GET /zoho-recruit/recruit/v2/{module_api_name}/search?email=user@example.com

# Search by phone
GET /zoho-recruit/recruit/v2/{module_api_name}/search?phone=555-1234

# Global word search
GET /zoho-recruit/recruit/v2/{module_api_name}/search?word=keyword
```

## Available Modules

| Module       | API Name       |
| ------------ | -------------- |
| Candidates   | `Candidates`   |
| Job Openings | `Job_Openings` |
| Applications | `Applications` |
| Interviews   | `Interviews`   |
| Departments  | `Departments`  |
| Clients      | `Clients`      |
| Contacts     | `Contacts`     |
| Campaigns    | `Campaigns`    |
| Referrals    | `Referrals`    |
| Tasks        | `Tasks`        |
| Events       | `Events`       |
| Vendors      | `Vendors`      |

## Query Parameters

| Parameter    | Type    | Description                     |
| ------------ | ------- | ------------------------------- |
| `fields`     | string  | Comma-separated field API names |
| `sort_order` | string  | `asc` or `desc`                 |
| `sort_by`    | string  | Field API name                  |
| `converted`  | string  | `true`, `false`, or `both`      |
| `approved`   | string  | `true`, `false`, or `both`      |
| `page`       | integer | Page number (default: 1)        |
| `per_page`   | integer | Records per page (max 200)      |

## Search Operators

**Text fields:**

- `equals`, `not_equal`, `starts_with`, `ends_with`, `contains`, `not_contains`, `in`

**Date/Number fields:**

- `equals`, `not_equal`, `greater_than`, `less_than`, `greater_equal`, `less_equal`, `between`

## Pagination

Uses page-based pagination:

- `page`: Page number (default: 1)
- `per_page`: Records per page (max: 200)

Response includes:

```json
{
  "data": [...],
  "info": {
    "per_page": 200,
    "count": 50,
    "page": 1,
    "more_records": false
  }
}
```

## Notes

- Module API names are case-sensitive (e.g., `Job_Openings`)
- Maximum 200 records per GET request
- Maximum 100 records per POST/PUT/DELETE request
- `Last_Name` is mandatory for Candidates
- Date format: `yyyy-MM-dd`
- DateTime format: `yyyy-MM-ddTHH:mm:ss±HH:mm` (ISO 8601)
- Lookup fields use JSON objects with `id`

## Resources

- [Zoho Recruit API v2 Overview](https://www.zoho.com/recruit/developer-guide/apiv2/)
- [Get Records API](https://www.zoho.com/recruit/developer-guide/apiv2/get-records.html)
- [Search Records API](https://www.zoho.com/recruit/developer-guide/apiv2/search-records.html)
