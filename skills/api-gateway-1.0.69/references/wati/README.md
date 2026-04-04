# WATI Routing Reference

**App name:** `wati`
**Base URL proxied:** `{tenant}.wati.io`

## API Path Pattern

```
/wati/api/v1/{endpoint}
/wati/api/v2/{endpoint}
```

Both v1 and v2 endpoints are supported. v2 provides enhanced response formats with message tracking IDs.

## Common Endpoints

### Contacts

#### Get Contacts

```bash
GET /wati/api/v1/getContacts?pageSize=10&pageNumber=1
```

Optional filters: `name`, `attribute`, `createdDate`

#### Add Contact

```bash
POST /wati/api/v1/addContact/{whatsappNumber}
Content-Type: application/json

{
  "name": "John Doe",
  "customParams": [
    {"name": "member", "value": "VIP"}
  ]
}
```

#### Update Contact Attributes

```bash
POST /wati/api/v1/updateContactAttributes/{whatsappNumber}
Content-Type: application/json

{
  "customParams": [
    {"name": "member", "value": "VIP"}
  ]
}
```

### Messages

#### Get Messages

```bash
GET /wati/api/v1/getMessages/{whatsappNumber}?pageSize=10&pageNumber=1
```

#### Send Session Message

```bash
POST /wati/api/v1/sendSessionMessage/{whatsappNumber}
Content-Type: application/x-www-form-urlencoded

messageText=Hello%20World
```

#### Send Session File

```bash
POST /wati/api/v1/sendSessionFile/{whatsappNumber}
Content-Type: multipart/form-data

file=@document.pdf
```

### Message Templates

#### Get Message Templates

```bash
GET /wati/api/v1/getMessageTemplates?pageSize=10&pageNumber=1
```

#### Send Template Message

```bash
POST /wati/api/v1/sendTemplateMessage?whatsappNumber={whatsappNumber}
Content-Type: application/json

{
  "template_name": "order_update",
  "broadcast_name": "order_update",
  "parameters": [
    {"name": "name", "value": "John"},
    {"name": "ordernumber", "value": "12345"}
  ]
}
```

#### Send Template Messages (Bulk)

```bash
POST /wati/api/v1/sendTemplateMessages
Content-Type: application/json

{
  "template_name": "order_update",
  "broadcast_name": "order_update",
  "receivers": [
    {
      "whatsappNumber": "14155551234",
      "customParams": [{"name": "name", "value": "John"}]
    }
  ]
}
```

### Message Templates (v2)

v2 endpoints return `localMessageId` for tracking.

#### Send Template Message (v2)

```bash
POST /wati/api/v2/sendTemplateMessage?whatsappNumber={whatsappNumber}
Content-Type: application/json

{
  "template_name": "order_update",
  "broadcast_name": "order_update",
  "parameters": [{"name": "name", "value": "John"}]
}
```

#### Send Template Messages (v2 - Bulk)

```bash
POST /wati/api/v2/sendTemplateMessages
Content-Type: application/json

{
  "template_name": "order_update",
  "broadcast_name": "order_update",
  "receivers": [
    {
      "whatsappNumber": "14155551234",
      "customParams": [{"name": "name", "value": "John"}]
    }
  ]
}
```

### Interactive Messages

#### Send Interactive Buttons Message

```bash
POST /wati/api/v1/sendInteractiveButtonsMessage?whatsappNumber={whatsappNumber}
Content-Type: application/json

{
  "header": {"type": "text", "text": "Header"},
  "body": "Message body",
  "footer": "Footer text",
  "buttons": [{"text": "Button 1"}]
}
```

#### Send Interactive List Message

```bash
POST /wati/api/v1/sendInteractiveListMessage?whatsappNumber={whatsappNumber}
Content-Type: application/json

{
  "header": "Header",
  "body": "Message body",
  "footer": "Footer",
  "buttonText": "View Options",
  "sections": [
    {
      "title": "Section 1",
      "rows": [{"title": "Option A", "description": "Description"}]
    }
  ]
}
```

### Operators

#### Assign Operator

```bash
POST /wati/api/v1/assignOperator?email=agent@example.com&whatsappNumber={whatsappNumber}
```

### Media

#### Get Media

```bash
GET /wati/api/v1/getMedia?fileName={fileName}
```

## Pagination

Uses page-based pagination:

```bash
GET /wati/api/v1/getContacts?pageSize=50&pageNumber=1
```

**Parameters:**

- `pageSize` - Results per page
- `pageNumber` - Page number (1-indexed)

## Notes

- WhatsApp numbers should include country code without + or spaces (e.g., `14155551234`)
- Session messages require an active 24-hour conversation window
- Template messages require pre-approved WhatsApp templates
- Interactive messages have character limits enforced by WhatsApp

## Resources

- [WATI API Documentation](https://docs.wati.io/reference/introduction)
- [WATI Help Center](https://docs.wati.io/)
