# Resend Routing Reference

**App name:** `resend`
**Base URL proxied:** `api.resend.com`

## API Path Pattern

```
/resend/{resource}
```

## Emails

### Send Email

```bash
POST /resend/emails
Content-Type: application/json

{
  "from": "sender@yourdomain.com",
  "to": ["recipient@example.com"],
  "subject": "Hello",
  "html": "<p>Hello World</p>"
}
```

### Send Batch Emails

```bash
POST /resend/emails/batch
Content-Type: application/json

[
  {"from": "sender@yourdomain.com", "to": ["a@example.com"], "subject": "Hi A", "text": "Hello A"},
  {"from": "sender@yourdomain.com", "to": ["b@example.com"], "subject": "Hi B", "text": "Hello B"}
]
```

### List Emails

```bash
GET /resend/emails
```

### Get Email

```bash
GET /resend/emails/{email_id}
```

### Update Email (Cancel Scheduled)

```bash
PATCH /resend/emails/{email_id}
Content-Type: application/json

{"scheduled_at": "2026-03-15T10:00:00Z"}
```

### Cancel Scheduled Email

```bash
POST /resend/emails/{email_id}/cancel
```

## Domains

### List Domains

```bash
GET /resend/domains
```

### Create Domain

```bash
POST /resend/domains
Content-Type: application/json

{"name": "example.com"}
```

### Get Domain

```bash
GET /resend/domains/{domain_id}
```

### Update Domain

```bash
PATCH /resend/domains/{domain_id}
Content-Type: application/json

{"open_tracking": true, "click_tracking": true}
```

### Delete Domain

```bash
DELETE /resend/domains/{domain_id}
```

### Verify Domain

```bash
POST /resend/domains/{domain_id}/verify
```

## Audiences

### List Audiences

```bash
GET /resend/audiences
```

### Create Audience

```bash
POST /resend/audiences
Content-Type: application/json

{"name": "Newsletter Subscribers"}
```

### Get Audience

```bash
GET /resend/audiences/{audience_id}
```

### Delete Audience

```bash
DELETE /resend/audiences/{audience_id}
```

## Contacts

### List Contacts

```bash
GET /resend/audiences/{audience_id}/contacts
```

### Create Contact

```bash
POST /resend/audiences/{audience_id}/contacts
Content-Type: application/json

{
  "email": "user@example.com",
  "first_name": "John",
  "last_name": "Doe",
  "unsubscribed": false
}
```

### Get Contact

```bash
GET /resend/audiences/{audience_id}/contacts/{contact_id}
```

### Update Contact

```bash
PATCH /resend/audiences/{audience_id}/contacts/{contact_id}
Content-Type: application/json

{"first_name": "Jane", "unsubscribed": true}
```

### Delete Contact

```bash
DELETE /resend/audiences/{audience_id}/contacts/{contact_id}
```

## Broadcasts

### List Broadcasts

```bash
GET /resend/broadcasts
```

### Create Broadcast

```bash
POST /resend/broadcasts
Content-Type: application/json

{
  "name": "Weekly Newsletter",
  "audience_id": "aud_123",
  "from": "newsletter@yourdomain.com",
  "subject": "This Week's Update",
  "html": "<p>Newsletter content</p>"
}
```

### Get Broadcast

```bash
GET /resend/broadcasts/{broadcast_id}
```

### Update Broadcast

```bash
PATCH /resend/broadcasts/{broadcast_id}
Content-Type: application/json

{"name": "Updated Newsletter", "subject": "New Subject"}
```

### Delete Broadcast

```bash
DELETE /resend/broadcasts/{broadcast_id}
```

### Send Broadcast

```bash
POST /resend/broadcasts/{broadcast_id}/send
```

## Segments

### List Segments

```bash
GET /resend/segments
```

### Create Segment

```bash
POST /resend/segments
Content-Type: application/json

{"name": "Active Users", "audience_id": "aud_123"}
```

### Get Segment

```bash
GET /resend/segments/{segment_id}
```

### Delete Segment

```bash
DELETE /resend/segments/{segment_id}
```

## Topics

### List Topics

```bash
GET /resend/topics
```

### Create Topic

```bash
POST /resend/topics
Content-Type: application/json

{
  "audience_id": "aud_123",
  "name": "Product Updates",
  "default_subscription": true
}
```

Note: `default_subscription` is required and must be a boolean.

### Get Topic

```bash
GET /resend/topics/{topic_id}
```

### Update Topic

```bash
PATCH /resend/topics/{topic_id}
Content-Type: application/json

{"name": "Updated Topic Name"}
```

### Delete Topic

```bash
DELETE /resend/topics/{topic_id}
```

## Webhooks

### List Webhooks

```bash
GET /resend/webhooks
```

### Create Webhook

```bash
POST /resend/webhooks
Content-Type: application/json

{
  "endpoint": "https://example.com/webhook",
  "events": ["email.sent", "email.delivered", "email.bounced", "email.opened", "email.clicked"]
}
```

Note: Use `endpoint` field, not `endpoint_url`.

### Get Webhook

```bash
GET /resend/webhooks/{webhook_id}
```

### Update Webhook

```bash
PUT /resend/webhooks/{webhook_id}
Content-Type: application/json

{
  "endpoint": "https://example.com/new-webhook",
  "events": ["email.sent", "email.delivered"]
}
```

### Delete Webhook

```bash
DELETE /resend/webhooks/{webhook_id}
```

## API Keys

### List API Keys

```bash
GET /resend/api-keys
```

### Create API Key

```bash
POST /resend/api-keys
Content-Type: application/json

{"name": "Production Key"}
```

### Delete API Key

```bash
DELETE /resend/api-keys/{api_key_id}
```

## Contact Properties (Custom Fields)

### List Contact Properties

```bash
GET /resend/contact-properties
```

### Create Contact Property

```bash
POST /resend/contact-properties
Content-Type: application/json

{
  "name": "company",
  "type": "string",
  "audience_id": "aud_123"
}
```

Types: `string`, `number`, `boolean`, `date`

### Update Contact Property

```bash
PATCH /resend/contact-properties/{property_id}
Content-Type: application/json

{"name": "updated_property_name"}
```

### Delete Contact Property

```bash
DELETE /resend/contact-properties/{property_id}
```

## Rate Limits

- 2 requests per second
- Add delays between requests to avoid rate limiting

## Notes

- Domain must be verified before sending emails
- Emails sent from unverified domains return 403 errors
- Use `endpoint` (not `endpoint_url`) for webhooks
- Topics require `default_subscription` field (boolean)
- Broadcasts require an audience_id and verified domain
- Contact properties (custom fields) are scoped to audiences

## Resources

- [Resend API Documentation](https://resend.com/docs/api-reference/introduction)
- [Resend Dashboard](https://resend.com/overview)
