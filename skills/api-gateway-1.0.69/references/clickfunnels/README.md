# ClickFunnels Routing Reference

**App name:** `clickfunnels`
**Base URL proxied:** `{subdomain}.myclickfunnels.com`

The router automatically handles the subdomain from your OAuth connection.

## API Path Pattern

```
/clickfunnels/api/v2/{resource}
```

## Required Headers

THe `User-Agent` header is required to avoid Cloudflare blocks:

```
User-Agent: Maton/1.0
```

## Common Endpoints

### Teams

#### List Teams

```bash
GET /clickfunnels/api/v2/teams
```

#### Get Team

```bash
GET /clickfunnels/api/v2/teams/{team_id}
```

### Workspaces

#### List Workspaces

```bash
GET /clickfunnels/api/v2/teams/{team_id}/workspaces
```

#### Get Workspace

```bash
GET /clickfunnels/api/v2/workspaces/{workspace_id}
```

### Contacts

#### List Contacts

```bash
GET /clickfunnels/api/v2/workspaces/{workspace_id}/contacts
```

#### Get Contact

```bash
GET /clickfunnels/api/v2/contacts/{contact_id}
```

#### Create Contact

```bash
POST /clickfunnels/api/v2/workspaces/{workspace_id}/contacts
Content-Type: application/json

{
  "contact": {
    "email_address": "user@example.com",
    "first_name": "John",
    "last_name": "Doe"
  }
}
```

#### Update Contact

```bash
PUT /clickfunnels/api/v2/contacts/{contact_id}
Content-Type: application/json

{
  "contact": {
    "first_name": "Updated"
  }
}
```

#### Delete Contact

```bash
DELETE /clickfunnels/api/v2/contacts/{contact_id}
```

#### Upsert Contact

```bash
POST /clickfunnels/api/v2/workspaces/{workspace_id}/contacts/upsert
```

### Products

#### List Products

```bash
GET /clickfunnels/api/v2/workspaces/{workspace_id}/products
```

#### Get Product

```bash
GET /clickfunnels/api/v2/products/{product_id}
```

#### Create Product

```bash
POST /clickfunnels/api/v2/workspaces/{workspace_id}/products
Content-Type: application/json

{
  "product": {
    "name": "New Product",
    "visible_in_store": true
  }
}
```

#### Archive/Unarchive Product

```bash
POST /clickfunnels/api/v2/products/{product_id}/archive
POST /clickfunnels/api/v2/products/{product_id}/unarchive
```

### Orders

#### List Orders

```bash
GET /clickfunnels/api/v2/workspaces/{workspace_id}/orders
```

#### Get Order

```bash
GET /clickfunnels/api/v2/orders/{order_id}
```

### Fulfillments

#### List Fulfillments

```bash
GET /clickfunnels/api/v2/workspaces/{workspace_id}/fulfillments
```

#### Create Fulfillment

```bash
POST /clickfunnels/api/v2/workspaces/{workspace_id}/fulfillments
```

#### Cancel Fulfillment

```bash
POST /clickfunnels/api/v2/fulfillments/{fulfillment_id}/cancel
```

### Courses & Enrollments

#### List Courses

```bash
GET /clickfunnels/api/v2/workspaces/{workspace_id}/courses
```

#### List Enrollments

```bash
GET /clickfunnels/api/v2/courses/{course_id}/enrollments
```

#### Create Enrollment

```bash
POST /clickfunnels/api/v2/courses/{course_id}/enrollments
```

### Forms & Submissions

#### List Forms

```bash
GET /clickfunnels/api/v2/workspaces/{workspace_id}/forms
```

#### List Submissions

```bash
GET /clickfunnels/api/v2/forms/{form_id}/submissions
```

### Webhooks

#### List Webhook Endpoints

```bash
GET /clickfunnels/api/v2/workspaces/{workspace_id}/webhooks/outgoing/endpoints
```

#### Create Webhook Endpoint

```bash
POST /clickfunnels/api/v2/workspaces/{workspace_id}/webhooks/outgoing/endpoints
Content-Type: application/json

{
  "webhooks_outgoing_endpoint": {
    "url": "https://example.com/webhook",
    "name": "My Webhook",
    "event_type_ids": ["contact.created"]
  }
}
```

#### Delete Webhook Endpoint

```bash
DELETE /clickfunnels/api/v2/webhooks/outgoing/endpoints/{endpoint_id}
```

### Images

#### List Images

```bash
GET /clickfunnels/api/v2/workspaces/{workspace_id}/images
```

#### Upload Image via URL

```bash
POST /clickfunnels/api/v2/workspaces/{workspace_id}/images
Content-Type: application/json

{
  "image": {
    "upload_source_url": "https://example.com/image.png"
  }
}
```

## Pagination

Cursor-based pagination with 20 items per page:

```bash
# First page
GET /clickfunnels/api/v2/workspaces/{workspace_id}/contacts

# Next page (use ID from Pagination-Next header)
GET /clickfunnels/api/v2/workspaces/{workspace_id}/contacts?after=1087091674
```

Response headers:

- `Pagination-Next`: ID of last item
- `Link`: Full URL for next page

## Filtering

```bash
# Single filter
GET /clickfunnels/api/v2/workspaces/{workspace_id}/contacts?filter[email_address]=user@example.com

# Multiple values (OR)
GET /clickfunnels/api/v2/workspaces/{workspace_id}/contacts?filter[email_address]=a@example.com,b@example.com

# Multiple filters (AND)
GET /clickfunnels/api/v2/workspaces/{workspace_id}/contacts?filter[email_address]=user@example.com&filter[id]=123
```

## Notes

- Subdomain is automatically determined from your OAuth connection
- IDs are integers; each resource also has a `public_id` string
- Request bodies use nested keys: `{"contact": {...}}`, `{"product": {...}}`
- List endpoints: use `workspaces/{id}/{resource}` pattern
- Single resource: use `/{resource}/{id}` pattern (no workspace prefix)
- Delete operations return HTTP 204 with empty body
- Max 20 items per page, use `after` parameter for pagination

## Resources

- [ClickFunnels API Introduction](https://developers.myclickfunnels.com/docs/intro)
- [ClickFunnels API Reference](https://developers.myclickfunnels.com/reference)
- [Pagination Guide](https://developers.myclickfunnels.com/docs/pagination)
- [Filtering Guide](https://developers.myclickfunnels.com/docs/filtering)
