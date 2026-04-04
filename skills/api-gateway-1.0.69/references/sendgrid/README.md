# SendGrid Routing Reference

**App name:** `sendgrid`
**Base URL proxied:** `api.sendgrid.com`

## API Path Pattern

```
/sendgrid/v3/{resource}
```

## Common Endpoints

### Mail Send

```bash
POST /sendgrid/v3/mail/send
Content-Type: application/json

{
  "personalizations": [{"to": [{"email": "recipient@example.com"}], "subject": "Hello"}],
  "from": {"email": "sender@example.com"},
  "content": [{"type": "text/plain", "value": "Hello World"}]
}
```

### User Profile

```bash
GET /sendgrid/v3/user/profile
GET /sendgrid/v3/user/account
```

### Marketing Contacts

```bash
GET /sendgrid/v3/marketing/contacts
PUT /sendgrid/v3/marketing/contacts
DELETE /sendgrid/v3/marketing/contacts?ids=id1,id2
POST /sendgrid/v3/marketing/contacts/search
```

### Marketing Lists

```bash
GET /sendgrid/v3/marketing/lists
POST /sendgrid/v3/marketing/lists
GET /sendgrid/v3/marketing/lists/{list_id}
PATCH /sendgrid/v3/marketing/lists/{list_id}
DELETE /sendgrid/v3/marketing/lists/{list_id}
```

### Segments

```bash
GET /sendgrid/v3/marketing/segments
POST /sendgrid/v3/marketing/segments
DELETE /sendgrid/v3/marketing/segments/{segment_id}
```

### Templates

```bash
GET /sendgrid/v3/templates
POST /sendgrid/v3/templates
GET /sendgrid/v3/templates/{template_id}
PATCH /sendgrid/v3/templates/{template_id}
DELETE /sendgrid/v3/templates/{template_id}
```

### Senders

```bash
GET /sendgrid/v3/senders
POST /sendgrid/v3/senders
PATCH /sendgrid/v3/senders/{sender_id}
DELETE /sendgrid/v3/senders/{sender_id}
```

### Suppressions

```bash
GET /sendgrid/v3/suppression/bounces
GET /sendgrid/v3/suppression/blocks
GET /sendgrid/v3/suppression/invalid_emails
GET /sendgrid/v3/suppression/spam_reports
GET /sendgrid/v3/suppression/unsubscribes
```

### Unsubscribe Groups (ASM)

```bash
GET /sendgrid/v3/asm/groups
POST /sendgrid/v3/asm/groups
PATCH /sendgrid/v3/asm/groups/{group_id}
DELETE /sendgrid/v3/asm/groups/{group_id}
```

### Statistics

```bash
GET /sendgrid/v3/stats?start_date=2026-02-01
GET /sendgrid/v3/categories/stats?start_date=2026-02-01&categories=cat1
GET /sendgrid/v3/mailbox_providers/stats?start_date=2026-02-01
```

### API Keys

```bash
GET /sendgrid/v3/api_keys
POST /sendgrid/v3/api_keys
PATCH /sendgrid/v3/api_keys/{api_key_id}
DELETE /sendgrid/v3/api_keys/{api_key_id}
```

## Pagination

Marketing endpoints use token-based pagination:

```bash
GET /sendgrid/v3/marketing/lists?page_size=100&page_token={token}
```

Suppression endpoints use offset pagination:

```bash
GET /sendgrid/v3/suppression/bounces?limit=100&offset=0
```

## Notes

- All requests use JSON content type
- Dates are in YYYY-MM-DD format
- Mail send returns 202 Accepted on success
- Dynamic template IDs start with `d-`
- Marketing contact operations are asynchronous

## Resources

- [SendGrid API Documentation](https://www.twilio.com/docs/sendgrid/api-reference)
- [Mail Send API](https://www.twilio.com/docs/sendgrid/api-reference/mail-send)
