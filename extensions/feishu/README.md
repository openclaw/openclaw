# @openclaw/feishu

Feishu/Lark channel plugin for OpenClaw.

## Bitable record payload compatibility

`feishu_bitable_create_record` and `feishu_bitable_update_record` support two equivalent payload styles:

- `fields`: direct object map
- `fields_json`: JSON string fallback (for clients that cannot pass dynamic object maps reliably)

Use exactly one of them in each call.

### Examples

```json
{
  "app_token": "bascnxxxx",
  "table_id": "tblxxxx",
  "fields": {
    "Name": "Alice",
    "Score": 95
  }
}
```

```json
{
  "app_token": "bascnxxxx",
  "table_id": "tblxxxx",
  "fields_json": "{\"Name\":\"Alice\",\"Score\":95}"
}
```
