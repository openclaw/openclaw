# Brevo Routing Reference

**App name:** `brevo`
**Base URL proxied:** `api.brevo.com`

## API Path Pattern

```
/brevo/v3/{resource}
```

## Common Endpoints

### Account

```bash
GET /brevo/v3/account
```

### Contacts

#### List Contacts

```bash
GET /brevo/v3/contacts?limit=50&offset=0
```

#### Get Contact

```bash
GET /brevo/v3/contacts/{identifier}
```

#### Create Contact

```bash
POST /brevo/v3/contacts
Content-Type: application/json

{
  "email": "contact@example.com",
  "attributes": {"FIRSTNAME": "John", "LASTNAME": "Doe"},
  "listIds": [2]
}
```

#### Update Contact

```bash
PUT /brevo/v3/contacts/{identifier}
Content-Type: application/json

{
  "attributes": {"FIRSTNAME": "Updated"}
}
```

#### Delete Contact

```bash
DELETE /brevo/v3/contacts/{identifier}
```

### Lists

#### List All Lists

```bash
GET /brevo/v3/contacts/lists
```

#### Create List

```bash
POST /brevo/v3/contacts/lists
Content-Type: application/json

{
  "name": "New List",
  "folderId": 1
}
```

#### Add Contacts to List

```bash
POST /brevo/v3/contacts/lists/{listId}/contacts/add
Content-Type: application/json

{
  "emails": ["contact@example.com"]
}
```

### Folders

#### List Folders

```bash
GET /brevo/v3/contacts/folders
```

#### Create Folder

```bash
POST /brevo/v3/contacts/folders
Content-Type: application/json

{
  "name": "New Folder"
}
```

### Transactional Emails

#### Send Email

```bash
POST /brevo/v3/smtp/email
Content-Type: application/json

{
  "sender": {"name": "John", "email": "john@example.com"},
  "to": [{"email": "recipient@example.com", "name": "Jane"}],
  "subject": "Hello!",
  "htmlContent": "<html><body><h1>Hi!</h1></body></html>"
}
```

#### Get Email Statistics

```bash
GET /brevo/v3/smtp/statistics/events?limit=50
```

### Email Templates

#### List Templates

```bash
GET /brevo/v3/smtp/templates
```

#### Create Template

```bash
POST /brevo/v3/smtp/templates
Content-Type: application/json

{
  "sender": {"name": "Company", "email": "noreply@company.com"},
  "templateName": "Welcome Email",
  "subject": "Welcome {{params.name}}!",
  "htmlContent": "<html><body><h1>Hello {{params.name}}!</h1></body></html>"
}
```

### Email Campaigns

#### List Campaigns

```bash
GET /brevo/v3/emailCampaigns
```

#### Create Campaign

```bash
POST /brevo/v3/emailCampaigns
Content-Type: application/json

{
  "name": "Newsletter",
  "subject": "Monthly Update",
  "sender": {"name": "Company", "email": "news@company.com"},
  "htmlContent": "<html><body><h1>News</h1></body></html>",
  "recipients": {"listIds": [2]}
}
```

#### Send Campaign

```bash
POST /brevo/v3/emailCampaigns/{campaignId}/sendNow
```

### Senders

#### List Senders

```bash
GET /brevo/v3/senders
```

#### Create Sender

```bash
POST /brevo/v3/senders
Content-Type: application/json

{
  "name": "Marketing",
  "email": "marketing@company.com"
}
```

### Attributes

#### List Attributes

```bash
GET /brevo/v3/contacts/attributes
```

## Pagination

Brevo uses offset-based pagination:

```bash
GET /brevo/v3/contacts?limit=50&offset=0
```

**Parameters:**

- `limit` - Results per page (max varies by endpoint, typically 500)
- `offset` - Starting index (0-based)

Response includes count:

```json
{
  "contacts": [...],
  "count": 150
}
```

## Notes

- All endpoints require `/v3/` prefix
- Attribute names must be UPPERCASE
- Contact identifiers: email, phone, or ID
- Template parameters: `{{params.name}}` syntax
- PUT/DELETE return 204 No Content on success
- Rate limit: 300 calls/min (free), higher on paid plans

## Resources

- [Brevo API Overview](https://developers.brevo.com/)
- [API Key Concepts](https://developers.brevo.com/docs/how-it-works)
- [Manage Contacts](https://developers.brevo.com/docs/synchronise-contact-lists)
- [Send Transactional Email](https://developers.brevo.com/docs/send-a-transactional-email)
