# Systeme.io Routing Reference

**App name:** `systeme`
**Base URL proxied:** `api.systeme.io`

## API Path Pattern

```
/systeme/api/{resource}
```

## Common Endpoints

### List Contacts

```bash
GET /systeme/api/contacts
```

Query parameters:

- `limit` - Results per page (10-100)
- `startingAfter` - ID of last item for pagination
- `order` - Sort order: `asc` or `desc` (default: `desc`)

### Get Contact

```bash
GET /systeme/api/contacts/{id}
```

### Create Contact

```bash
POST /systeme/api/contacts
Content-Type: application/json

{
  "email": "user@example.com",
  "firstName": "John",
  "lastName": "Doe"
}
```

### Update Contact

```bash
PATCH /systeme/api/contacts/{id}
Content-Type: application/merge-patch+json

{
  "firstName": "Jane"
}
```

### Delete Contact

```bash
DELETE /systeme/api/contacts/{id}
```

### List Tags

```bash
GET /systeme/api/tags
```

### Create Tag

```bash
POST /systeme/api/tags
Content-Type: application/json

{
  "name": "VIP Customer"
}
```

### Update Tag

```bash
PUT /systeme/api/tags/{id}
Content-Type: application/json

{
  "name": "Premium Customer"
}
```

### Delete Tag

```bash
DELETE /systeme/api/tags/{id}
```

### Assign Tag to Contact

```bash
POST /systeme/api/contacts/{id}/tags
Content-Type: application/json

{
  "tagId": 12345
}
```

### Remove Tag from Contact

```bash
DELETE /systeme/api/contacts/{id}/tags/{tagId}
```

### List Contact Fields

```bash
GET /systeme/api/contact_fields
```

### List Courses

```bash
GET /systeme/api/school/courses
```

### Create Enrollment

```bash
POST /systeme/api/school/courses/{courseId}/enrollments
Content-Type: application/json

{
  "contactId": 12345
}
```

### List Enrollments

```bash
GET /systeme/api/school/enrollments
```

### Delete Enrollment

```bash
DELETE /systeme/api/school/enrollments/{id}
```

### List Communities

```bash
GET /systeme/api/community/communities
```

### Create Membership

```bash
POST /systeme/api/community/communities/{communityId}/memberships
Content-Type: application/json

{
  "contactId": 12345
}
```

### List Memberships

```bash
GET /systeme/api/community/memberships
```

### Delete Membership

```bash
DELETE /systeme/api/community/memberships/{id}
```

### List Subscriptions

```bash
GET /systeme/api/payment/subscriptions
```

### Cancel Subscription

```bash
POST /systeme/api/payment/subscriptions/{id}/cancel
```

### List Webhooks

```bash
GET /systeme/api/webhooks
```

### Create Webhook

```bash
POST /systeme/api/webhooks
Content-Type: application/json

{
  "name": "My Webhook",
  "url": "https://example.com/webhook",
  "secret": "my-secret-key",
  "subscriptions": ["CONTACT_CREATED"]
}
```

Available events: `CONTACT_CREATED`, `CONTACT_TAG_ADDED`, `CONTACT_TAG_REMOVED`, `CONTACT_OPT_IN`, `SALE_NEW`, `SALE_CANCELED`

### Update Webhook

```bash
PATCH /systeme/api/webhooks/{id}
Content-Type: application/merge-patch+json

{
  "name": "Updated Webhook Name"
}
```

### Delete Webhook

```bash
DELETE /systeme/api/webhooks/{id}
```

## Notes

- Contact, tag, course, and enrollment IDs are numeric integers
- Webhook IDs are UUIDs
- Uses cursor-based pagination with `startingAfter` parameter
- PATCH requests require `Content-Type: application/merge-patch+json`
- Delete operations return 204 No Content
- Email addresses are validated for real MX records
- Payment/subscription endpoints may return 404 if not configured

## Resources

- [Systeme.io API Reference](https://developer.systeme.io/reference)
- [Systeme.io Developer Documentation](https://developer.systeme.io/)
