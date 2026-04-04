# Keap Routing Reference

**App name:** `keap`
**Base URL proxied:** `api.infusionsoft.com/crm/rest`

## API Path Pattern

```
/keap/crm/rest/v2/{resource}
```

Note: The `/crm/rest` prefix is required in the path.

## Common Endpoints

### Get Current User

```bash
GET /keap/crm/rest/v2/oauth/connect/userinfo
```

### List Contacts

```bash
GET /keap/crm/rest/v2/contacts
```

Query parameters: `page_size`, `page_token`, `filter`, `order_by`, `fields`

### Get Contact

```bash
GET /keap/crm/rest/v2/contacts/{contact_id}
```

### Create Contact

```bash
POST /keap/crm/rest/v2/contacts
Content-Type: application/json

{
  "given_name": "John",
  "family_name": "Doe",
  "email_addresses": [{"email": "john@example.com", "field": "EMAIL1"}]
}
```

### Update Contact

```bash
PATCH /keap/crm/rest/v2/contacts/{contact_id}
Content-Type: application/json

{
  "given_name": "Jane"
}
```

### Delete Contact

```bash
DELETE /keap/crm/rest/v2/contacts/{contact_id}
```

### List Companies

```bash
GET /keap/crm/rest/v2/companies
```

### List Tags

```bash
GET /keap/crm/rest/v2/tags
```

### Apply Tags to Contacts

```bash
POST /keap/crm/rest/v2/tags/{tag_id}/contacts:applyTags
Content-Type: application/json

{
  "contact_ids": ["1", "2", "3"]
}
```

### List Tasks

```bash
GET /keap/crm/rest/v2/tasks
```

### Create Task

```bash
POST /keap/crm/rest/v2/tasks
Content-Type: application/json

{
  "title": "Follow up call",
  "due_date": "2026-02-15T10:00:00Z",
  "contact": {"id": "9"}
}
```

### List Opportunities

```bash
GET /keap/crm/rest/v2/opportunities
```

### List Orders

```bash
GET /keap/crm/rest/v2/orders
```

### List Products

```bash
GET /keap/crm/rest/v2/products
```

### List Campaigns

```bash
GET /keap/crm/rest/v2/campaigns
```

### Add Contacts to Campaign Sequence

```bash
POST /keap/crm/rest/v2/campaigns/{campaign_id}/sequences/{sequence_id}:addContacts
Content-Type: application/json

{
  "contact_ids": ["1", "2"]
}
```

### List Emails

```bash
GET /keap/crm/rest/v2/emails
```

### Send Email

```bash
POST /keap/crm/rest/v2/emails:send
Content-Type: application/json

{
  "contacts": [{"id": "9"}],
  "subject": "Hello",
  "html_content": "<p>Email body</p>"
}
```

### List Automations

```bash
GET /keap/crm/rest/v2/automations
```

### List Affiliates

```bash
GET /keap/crm/rest/v2/affiliates
```

### List Subscriptions

```bash
GET /keap/crm/rest/v2/subscriptions
```

## Pagination

Uses token-based pagination:

```bash
GET /keap/crm/rest/v2/contacts?page_size=50
GET /keap/crm/rest/v2/contacts?page_size=50&page_token=NEXT_TOKEN
```

Response includes `next_page_token` (empty when no more pages).

## Filtering

Use the `filter` parameter:

```bash
GET /keap/crm/rest/v2/contacts?filter=given_name==John
GET /keap/crm/rest/v2/tasks?filter=completed==false
```

## Notes

- API version is v2 (v1 is deprecated)
- Path must include `/crm/rest` prefix
- IDs are returned as strings
- Maximum `page_size` is 1000
- Timestamps use ISO 8601 format

## Resources

- [Keap Developer Portal](https://developer.infusionsoft.com/)
- [Keap REST API V2 Documentation](https://developer.infusionsoft.com/docs/restv2/)
