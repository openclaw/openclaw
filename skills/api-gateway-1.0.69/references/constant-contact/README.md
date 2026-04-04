# Constant Contact Routing Reference

**App name:** `constant-contact`
**Base URL proxied:** `api.cc.email`

## API Path Pattern

```
/constant-contact/v3/{resource}
```

## Common Endpoints

### List Contacts

```bash
GET /constant-contact/v3/contacts
```

### Get Contact

```bash
GET /constant-contact/v3/contacts/{contact_id}
```

### Create Contact

```bash
POST /constant-contact/v3/contacts
Content-Type: application/json

{
  "email_address": {
    "address": "john@example.com",
    "permission_to_send": "implicit"
  },
  "first_name": "John",
  "last_name": "Doe",
  "list_memberships": ["list-uuid"]
}
```

### Update Contact

```bash
PUT /constant-contact/v3/contacts/{contact_id}
Content-Type: application/json

{
  "first_name": "John",
  "last_name": "Smith"
}
```

### Delete Contact

```bash
DELETE /constant-contact/v3/contacts/{contact_id}
```

### List Contact Lists

```bash
GET /constant-contact/v3/contact_lists
```

### Create Contact List

```bash
POST /constant-contact/v3/contact_lists
Content-Type: application/json

{
  "name": "Newsletter Subscribers",
  "description": "Main newsletter list"
}
```

### List Email Campaigns

```bash
GET /constant-contact/v3/emails
```

### Create Email Campaign

```bash
POST /constant-contact/v3/emails
Content-Type: application/json

{
  "name": "March Newsletter",
  "email_campaign_activities": [
    {
      "format_type": 5,
      "from_name": "Company",
      "from_email": "marketing@example.com",
      "reply_to_email": "reply@example.com",
      "subject": "Newsletter",
      "html_content": "<html><body>Hello</body></html>"
    }
  ]
}
```

### List Segments

```bash
GET /constant-contact/v3/segments
```

### List Tags

```bash
GET /constant-contact/v3/contact_tags
```

### Get Account Summary

```bash
GET /constant-contact/v3/account/summary
```

### Email Campaign Summaries

```bash
GET /constant-contact/v3/reports/summary_reports/email_campaign_summaries
```

## Notes

- Authentication is automatic - the router injects the OAuth token
- Resource IDs use UUID format (36 characters with hyphens)
- All dates use ISO-8601 format
- Uses cursor-based pagination with `limit` and `cursor` parameters
- Maximum 1,000 contact lists per account
- Bulk operations are asynchronous

## Resources

- [V3 API Overview](https://developer.constantcontact.com/api_guide/getting_started.html)
- [API Reference](https://developer.constantcontact.com/api_reference/index.html)
- [Technical Overview](https://developer.constantcontact.com/api_guide/v3_technical_overview.html)
