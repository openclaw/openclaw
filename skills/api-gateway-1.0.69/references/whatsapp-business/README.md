# WhatsApp Business Routing Reference

**App name:** `whatsapp-business`
**Base URL proxied:** `graph.facebook.com`

## API Path Pattern

```
/whatsapp-business/v21.0/{resource}
```

## Common Endpoints

### Send Text Message

```bash
POST /whatsapp-business/v21.0/{phone_number_id}/messages
Content-Type: application/json

{
  "messaging_product": "whatsapp",
  "to": "1234567890",
  "type": "text",
  "text": {"body": "Hello from WhatsApp!"}
}
```

### Send Template Message

```bash
POST /whatsapp-business/v21.0/{phone_number_id}/messages
Content-Type: application/json

{
  "messaging_product": "whatsapp",
  "to": "1234567890",
  "type": "template",
  "template": {
    "name": "hello_world",
    "language": {"code": "en_US"},
    "components": [
      {
        "type": "body",
        "parameters": [{"type": "text", "text": "John"}]
      }
    ]
  }
}
```

### Send Image Message

```bash
POST /whatsapp-business/v21.0/{phone_number_id}/messages
Content-Type: application/json

{
  "messaging_product": "whatsapp",
  "to": "1234567890",
  "type": "image",
  "image": {
    "link": "https://example.com/image.jpg",
    "caption": "Check out this image!"
  }
}
```

### Send Document Message

```bash
POST /whatsapp-business/v21.0/{phone_number_id}/messages
Content-Type: application/json

{
  "messaging_product": "whatsapp",
  "to": "1234567890",
  "type": "document",
  "document": {
    "link": "https://example.com/document.pdf",
    "filename": "report.pdf"
  }
}
```

### Send Interactive Button Message

```bash
POST /whatsapp-business/v21.0/{phone_number_id}/messages
Content-Type: application/json

{
  "messaging_product": "whatsapp",
  "to": "1234567890",
  "type": "interactive",
  "interactive": {
    "type": "button",
    "body": {"text": "Would you like to proceed?"},
    "action": {
      "buttons": [
        {"type": "reply", "reply": {"id": "yes", "title": "Yes"}},
        {"type": "reply", "reply": {"id": "no", "title": "No"}}
      ]
    }
  }
}
```

### Send Interactive List Message

```bash
POST /whatsapp-business/v21.0/{phone_number_id}/messages
Content-Type: application/json

{
  "messaging_product": "whatsapp",
  "to": "1234567890",
  "type": "interactive",
  "interactive": {
    "type": "list",
    "body": {"text": "Choose from the list below"},
    "action": {
      "button": "View Options",
      "sections": [
        {
          "title": "Products",
          "rows": [
            {"id": "prod1", "title": "Product 1"},
            {"id": "prod2", "title": "Product 2"}
          ]
        }
      ]
    }
  }
}
```

### Mark Message as Read

```bash
POST /whatsapp-business/v21.0/{phone_number_id}/messages
Content-Type: application/json

{
  "messaging_product": "whatsapp",
  "status": "read",
  "message_id": "wamid.xxxxx"
}
```

### Upload Media

```bash
POST /whatsapp-business/v21.0/{phone_number_id}/media
Content-Type: multipart/form-data

file=@/path/to/file.jpg
type=image/jpeg
messaging_product=whatsapp
```

### Get Media URL

```bash
GET /whatsapp-business/v21.0/{media_id}
```

### List Message Templates

```bash
GET /whatsapp-business/v21.0/{whatsapp_business_account_id}/message_templates
```

### Create Message Template

```bash
POST /whatsapp-business/v21.0/{whatsapp_business_account_id}/message_templates
Content-Type: application/json

{
  "name": "order_confirmation",
  "language": "en_US",
  "category": "UTILITY",
  "components": [
    {"type": "BODY", "text": "Hi {{1}}, your order #{{2}} has been confirmed!"}
  ]
}
```

### Get Business Profile

```bash
GET /whatsapp-business/v21.0/{phone_number_id}/whatsapp_business_profile?fields=about,address,description,email,websites
```

### Update Business Profile

```bash
POST /whatsapp-business/v21.0/{phone_number_id}/whatsapp_business_profile
Content-Type: application/json

{
  "messaging_product": "whatsapp",
  "about": "Your trusted partner",
  "description": "We provide excellent services"
}
```

## Notes

- Phone numbers must be in international format without `+` (e.g., `1234567890`)
- `messaging_product` must always be set to `whatsapp`
- Template messages are required for initiating conversations (24-hour messaging window)
- Media files must be publicly accessible URLs or uploaded via the Media API
- Interactive messages support up to 3 buttons or 10 list items
- Template categories: `AUTHENTICATION`, `MARKETING`, `UTILITY`

## Resources

- [WhatsApp Business API Overview](https://developers.facebook.com/docs/whatsapp/cloud-api/overview)
- [Send Messages](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages)
- [Message Templates](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates)
- [Media](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media)
- [Business Profiles](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/business-profiles)
- [Webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks)
- [Error Codes](https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes)
