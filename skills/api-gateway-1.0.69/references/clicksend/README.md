# ClickSend Routing Reference

**App name:** `clicksend`
**Base URL proxied:** `rest.clicksend.com`

## API Path Pattern

```
/clicksend/v3/{resource}
```

## Common Endpoints

### Account

#### Get Account

```bash
GET /clicksend/v3/account
```

### SMS

#### Send SMS

```bash
POST /clicksend/v3/sms/send
Content-Type: application/json

{
  "messages": [
    {
      "to": "+15551234567",
      "body": "Hello!",
      "source": "api"
    }
  ]
}
```

#### SMS History

```bash
GET /clicksend/v3/sms/history
```

#### SMS Templates

```bash
GET /clicksend/v3/sms/templates
POST /clicksend/v3/sms/templates
PUT /clicksend/v3/sms/templates/{template_id}
DELETE /clicksend/v3/sms/templates/{template_id}
```

### MMS

#### Send MMS

```bash
POST /clicksend/v3/mms/send
```

#### MMS History

```bash
GET /clicksend/v3/mms/history
```

### Voice

#### Send Voice

```bash
POST /clicksend/v3/voice/send
```

#### Voice Languages

```bash
GET /clicksend/v3/voice/lang
```

### Contact Lists

#### List All Lists

```bash
GET /clicksend/v3/lists
```

#### CRUD Operations

```bash
GET /clicksend/v3/lists/{list_id}
POST /clicksend/v3/lists
PUT /clicksend/v3/lists/{list_id}
DELETE /clicksend/v3/lists/{list_id}
```

### Contacts

#### List Contacts

```bash
GET /clicksend/v3/lists/{list_id}/contacts
```

#### CRUD Operations

```bash
GET /clicksend/v3/lists/{list_id}/contacts/{contact_id}
POST /clicksend/v3/lists/{list_id}/contacts
PUT /clicksend/v3/lists/{list_id}/contacts/{contact_id}
DELETE /clicksend/v3/lists/{list_id}/contacts/{contact_id}
```

### Email Addresses

```bash
GET /clicksend/v3/email/addresses
POST /clicksend/v3/email/addresses
DELETE /clicksend/v3/email/addresses/{email_address_id}
```

### Utility

```bash
GET /clicksend/v3/countries
```

## Response Format

All responses follow this structure:

```json
{
  "http_code": 200,
  "response_code": "SUCCESS",
  "response_msg": "Description",
  "data": { ... }
}
```

## Pagination

Uses page-based pagination:

```bash
GET /clicksend/v3/lists?page=2&limit=50
# Response includes total, per_page, current_page, last_page
```

## Notes

- Phone numbers must be E.164 format
- Timestamps are Unix timestamps
- Voice access requires account permissions
- SMS over 160 chars split into segments

## Resources

- [ClickSend Developer Portal](https://developers.clicksend.com/)
- [ClickSend REST API v3](https://developers.clicksend.com/docs)
