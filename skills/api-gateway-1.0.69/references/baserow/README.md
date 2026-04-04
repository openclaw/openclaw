# Baserow Routing Reference

**App name:** `baserow`
**Base URL proxied:** `api.baserow.io`

## API Path Pattern

```
/baserow/api/database/rows/table/{table_id}/
/baserow/api/database/fields/table/{table_id}/
/baserow/api/database/tables/all-tables/
/baserow/api/user-files/upload-file/
/baserow/api/user-files/upload-via-url/
```

## Important Notes

- Connection uses API_KEY authentication (database token), not OAuth
- By default, fields return as `field_{id}`; use `user_field_names=true` for readable names
- Database tokens grant access only to database row endpoints
- Cloud has a limit of 10 concurrent API requests

## Common Endpoints

### List Rows

```bash
GET /baserow/api/database/rows/table/{table_id}/?user_field_names=true
```

### Get Row

```bash
GET /baserow/api/database/rows/table/{table_id}/{row_id}/
```

### Create Row

```bash
POST /baserow/api/database/rows/table/{table_id}/
Content-Type: application/json

{
  "field_123": "value"
}
```

### Update Row

```bash
PATCH /baserow/api/database/rows/table/{table_id}/{row_id}/
Content-Type: application/json

{
  "field_123": "updated value"
}
```

### Delete Row

```bash
DELETE /baserow/api/database/rows/table/{table_id}/{row_id}/
```

### Batch Create Rows

```bash
POST /baserow/api/database/rows/table/{table_id}/batch/
Content-Type: application/json

{
  "items": [
    {"field_123": "value1"},
    {"field_123": "value2"}
  ]
}
```

### Batch Update Rows

```bash
PATCH /baserow/api/database/rows/table/{table_id}/batch/
Content-Type: application/json

{
  "items": [
    {"id": 1, "field_123": "updated1"},
    {"id": 2, "field_123": "updated2"}
  ]
}
```

### Batch Delete Rows

```bash
POST /baserow/api/database/rows/table/{table_id}/batch-delete/
Content-Type: application/json

{
  "items": [1, 2, 3]
}
```

### List Fields

```bash
GET /baserow/api/database/fields/table/{table_id}/
```

### List All Tables

```bash
GET /baserow/api/database/tables/all-tables/
```

### Move Row

```bash
PATCH /baserow/api/database/rows/table/{table_id}/{row_id}/move/?before_id={row_id}
```

### Upload File via URL

```bash
POST /baserow/api/user-files/upload-via-url/
Content-Type: application/json

{
  "url": "https://example.com/image.png"
}
```

### Upload File (Multipart)

```bash
POST /baserow/api/user-files/upload-file/
Content-Type: multipart/form-data
```

## Query Parameters

- `user_field_names=true` - Use human-readable field names
- `size` - Rows per page (default: 100)
- `page` - Page number (1-indexed)
- `order_by` - Field to sort by (prefix `-` for descending)
- `filter__{field}__{operator}` - Filter rows
- `search` - Search across all fields
- `include` - Fields to include
- `exclude` - Fields to exclude

## Filter Operators

**Text:** `equal`, `not_equal`, `contains`, `contains_not`, `contains_word`, `doesnt_contain_word`, `length_is_lower_than`

**Numeric:** `higher_than`, `higher_than_or_equal`, `lower_than`, `lower_than_or_equal`, `is_even_and_whole`

**Date:** `date_is`, `date_is_not`, `date_is_before`, `date_is_on_or_before`, `date_is_after`, `date_is_on_or_after`, `date_is_within`, `date_equals_today`, `date_within_days`, `date_within_weeks`, `date_within_months`

**Boolean:** `boolean`

**Link Row:** `link_row_has`, `link_row_has_not`, `link_row_contains`, `link_row_not_contains`

**Select:** `single_select_equal`, `single_select_not_equal`, `single_select_is_any_of`, `single_select_is_none_of`, `multiple_select_has`, `multiple_select_has_not`

**File:** `filename_contains`, `has_file_type`, `files_lower_than`

**General:** `empty`, `not_empty`

## Resources

- [Baserow API Documentation](https://baserow.io/api-docs)
- [Baserow API Spec](https://api.baserow.io/api/redoc/)
- [Database Tokens](https://baserow.io/user-docs/personal-api-tokens)
