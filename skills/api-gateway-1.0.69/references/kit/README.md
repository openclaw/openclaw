# Kit Routing Reference

**App name:** `kit`
**Base URL proxied:** `api.kit.com`

## API Path Pattern

```
/kit/v4/{resource}
```

## Common Endpoints

### List Subscribers

```bash
GET /kit/v4/subscribers
```

Query parameters:

- `per_page` - Results per page (default: 500, max: 1000)
- `after` - Cursor for next page
- `before` - Cursor for previous page
- `status` - Filter by: `active`, `inactive`, `bounced`, `complained`, `cancelled`, or `all`
- `email_address` - Filter by specific email

### Get Subscriber

```bash
GET /kit/v4/subscribers/{id}
```

### Create Subscriber

```bash
POST /kit/v4/subscribers
Content-Type: application/json

{
  "email_address": "user@example.com",
  "first_name": "John"
}
```

### Update Subscriber

```bash
PUT /kit/v4/subscribers/{id}
Content-Type: application/json

{
  "first_name": "Updated Name"
}
```

### List Tags

```bash
GET /kit/v4/tags
```

### Create Tag

```bash
POST /kit/v4/tags
Content-Type: application/json

{
  "name": "new-tag"
}
```

### Update Tag

```bash
PUT /kit/v4/tags/{id}
Content-Type: application/json

{
  "name": "updated-tag-name"
}
```

### Delete Tag

```bash
DELETE /kit/v4/tags/{id}
```

### Tag a Subscriber

```bash
POST /kit/v4/tags/{tag_id}/subscribers
Content-Type: application/json

{
  "email_address": "user@example.com"
}
```

### Remove Tag from Subscriber

```bash
DELETE /kit/v4/tags/{tag_id}/subscribers/{subscriber_id}
```

### List Subscribers with Tag

```bash
GET /kit/v4/tags/{tag_id}/subscribers
```

### List Forms

```bash
GET /kit/v4/forms
```

### Add Subscriber to Form

```bash
POST /kit/v4/forms/{form_id}/subscribers
Content-Type: application/json

{
  "email_address": "user@example.com"
}
```

### List Form Subscribers

```bash
GET /kit/v4/forms/{form_id}/subscribers
```

### List Sequences

```bash
GET /kit/v4/sequences
```

### Add Subscriber to Sequence

```bash
POST /kit/v4/sequences/{sequence_id}/subscribers
Content-Type: application/json

{
  "email_address": "user@example.com"
}
```

### List Broadcasts

```bash
GET /kit/v4/broadcasts
```

### List Segments

```bash
GET /kit/v4/segments
```

### List Custom Fields

```bash
GET /kit/v4/custom_fields
```

### Create Custom Field

```bash
POST /kit/v4/custom_fields
Content-Type: application/json

{
  "label": "Company"
}
```

### Update Custom Field

```bash
PUT /kit/v4/custom_fields/{id}
Content-Type: application/json

{
  "label": "Company Name"
}
```

### Delete Custom Field

```bash
DELETE /kit/v4/custom_fields/{id}
```

### List Email Templates

```bash
GET /kit/v4/email_templates
```

### List Purchases

```bash
GET /kit/v4/purchases
```

### List Webhooks

```bash
GET /kit/v4/webhooks
```

### Create Webhook

```bash
POST /kit/v4/webhooks
Content-Type: application/json

{
  "target_url": "https://example.com/webhook",
  "event": {"name": "subscriber.subscriber_activate"}
}
```

### Delete Webhook

```bash
DELETE /kit/v4/webhooks/{id}
```

## Notes

- Kit API uses V4 (V3 is deprecated)
- Subscriber IDs are integers
- Custom field keys are auto-generated from labels
- Uses cursor-based pagination with `after` and `before` parameters
- Delete operations return 204 No Content
- Bulk operations (>100 items) are processed asynchronously

## Resources

- [Kit API Overview](https://developers.kit.com/api-reference/overview)
- [Kit API Reference](https://developers.kit.com/api-reference)
- [Kit Developer Documentation](https://developers.kit.com)
