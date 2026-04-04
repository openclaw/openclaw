# Mailchimp Routing Reference

**App name:** `mailchimp`
**Base URL proxied:** `{dc}.api.mailchimp.com`

## API Path Pattern

```
/mailchimp/3.0/{resource}
```

## Common Endpoints

### Get All Lists (Audiences)

```bash
GET /mailchimp/3.0/lists
```

Query parameters:

- `count` - Number of records to return (default 10, max 1000)
- `offset` - Number of records to skip (for pagination)

### Get a List

```bash
GET /mailchimp/3.0/lists/{list_id}
```

### Create a List

```bash
POST /mailchimp/3.0/lists
Content-Type: application/json

{
  "name": "Newsletter",
  "contact": {
    "company": "Acme Corp",
    "address1": "123 Main St",
    "city": "New York",
    "state": "NY",
    "zip": "10001",
    "country": "US"
  },
  "permission_reminder": "You signed up for our newsletter",
  "campaign_defaults": {
    "from_name": "Acme Corp",
    "from_email": "newsletter@acme.com",
    "subject": "",
    "language": "en"
  },
  "email_type_option": true
}
```

### Get List Members

```bash
GET /mailchimp/3.0/lists/{list_id}/members?status=subscribed&count=50
```

### Add a Member

```bash
POST /mailchimp/3.0/lists/{list_id}/members
Content-Type: application/json

{
  "email_address": "newuser@example.com",
  "status": "subscribed",
  "merge_fields": {
    "FNAME": "Jane",
    "LNAME": "Smith"
  }
}
```

### Update a Member

```bash
PATCH /mailchimp/3.0/lists/{list_id}/members/{subscriber_hash}
Content-Type: application/json

{
  "merge_fields": {
    "FNAME": "Jane",
    "LNAME": "Doe"
  }
}
```

### Add or Update a Member (Upsert)

```bash
PUT /mailchimp/3.0/lists/{list_id}/members/{subscriber_hash}
Content-Type: application/json

{
  "email_address": "user@example.com",
  "status_if_new": "subscribed",
  "merge_fields": {
    "FNAME": "Jane",
    "LNAME": "Smith"
  }
}
```

### Delete a Member

```bash
DELETE /mailchimp/3.0/lists/{list_id}/members/{subscriber_hash}
```

### Add or Remove Tags

```bash
POST /mailchimp/3.0/lists/{list_id}/members/{subscriber_hash}/tags
Content-Type: application/json

{
  "tags": [
    {"name": "VIP", "status": "active"},
    {"name": "Old Tag", "status": "inactive"}
  ]
}
```

### Get Segments

```bash
GET /mailchimp/3.0/lists/{list_id}/segments
```

### Get All Campaigns

```bash
GET /mailchimp/3.0/campaigns?status=sent&count=20
```

### Create a Campaign

```bash
POST /mailchimp/3.0/campaigns
Content-Type: application/json

{
  "type": "regular",
  "recipients": {
    "list_id": "LIST_ID"
  },
  "settings": {
    "subject_line": "Your Monthly Update",
    "from_name": "Acme Corp",
    "reply_to": "hello@acme.com"
  }
}
```

### Set Campaign Content

```bash
PUT /mailchimp/3.0/campaigns/{campaign_id}/content
Content-Type: application/json

{
  "html": "<html><body><h1>Hello!</h1><p>Newsletter content here.</p></body></html>",
  "plain_text": "Hello! Newsletter content here."
}
```

### Send a Campaign

```bash
POST /mailchimp/3.0/campaigns/{campaign_id}/actions/send
```

### Schedule a Campaign

```bash
POST /mailchimp/3.0/campaigns/{campaign_id}/actions/schedule
Content-Type: application/json

{
  "schedule_time": "2025-03-01T10:00:00+00:00"
}
```

### Get All Templates

```bash
GET /mailchimp/3.0/templates?type=user
```

### Get All Automations

```bash
GET /mailchimp/3.0/automations
```

### Start an Automation

```bash
POST /mailchimp/3.0/automations/{workflow_id}/actions/start-all-emails
```

### Get Campaign Reports

```bash
GET /mailchimp/3.0/reports?count=20
```

### Get Campaign Report

```bash
GET /mailchimp/3.0/reports/{campaign_id}
```

## Notes

- List IDs are 10-character alphanumeric strings
- Subscriber hashes are MD5 hashes of lowercase email addresses
- Timestamps are in ISO 8601 format
- Maximum 1000 records per request for list endpoints
- "Audience" and "list" are used interchangeably (app vs API terminology)
- "Contact" and "member" are used interchangeably (app vs API terminology)
- Use offset-based pagination with `count` and `offset` parameters

## Resources

- [Mailchimp Marketing API Documentation](https://mailchimp.com/developer/marketing/)
- [API Reference](https://mailchimp.com/developer/marketing/api/)
- [Quick Start Guide](https://mailchimp.com/developer/marketing/guides/quick-start/)
