# MailerLite Routing Reference

**App name:** `mailerlite`
**Base URL proxied:** `connect.mailerlite.com`

## API Path Pattern

```
/mailerlite/api/{resource}
```

## Common Endpoints

### Subscribers

#### List Subscribers

```bash
GET /mailerlite/api/subscribers
```

Query parameters: `filter[status]`, `limit`, `cursor`, `include`

#### Get Subscriber

```bash
GET /mailerlite/api/subscribers/{subscriber_id_or_email}
```

#### Create/Upsert Subscriber

```bash
POST /mailerlite/api/subscribers
Content-Type: application/json

{
  "email": "subscriber@example.com",
  "fields": {"name": "John Doe"},
  "groups": ["12345678901234567"],
  "status": "active"
}
```

#### Update Subscriber

```bash
PUT /mailerlite/api/subscribers/{subscriber_id}
Content-Type: application/json

{
  "fields": {"name": "Jane Doe"}
}
```

#### Delete Subscriber

```bash
DELETE /mailerlite/api/subscribers/{subscriber_id}
```

### Groups

#### List Groups

```bash
GET /mailerlite/api/groups
```

Query parameters: `limit`, `page`, `filter[name]`, `sort`

#### Create Group

```bash
POST /mailerlite/api/groups
Content-Type: application/json

{
  "name": "Newsletter Subscribers"
}
```

#### Update Group

```bash
PUT /mailerlite/api/groups/{group_id}
Content-Type: application/json

{
  "name": "Updated Group Name"
}
```

#### Delete Group

```bash
DELETE /mailerlite/api/groups/{group_id}
```

#### Get Group Subscribers

```bash
GET /mailerlite/api/groups/{group_id}/subscribers
```

### Campaigns

#### List Campaigns

```bash
GET /mailerlite/api/campaigns
```

Query parameters: `filter[status]`, `filter[type]`, `limit`, `page`

#### Get Campaign

```bash
GET /mailerlite/api/campaigns/{campaign_id}
```

#### Create Campaign

```bash
POST /mailerlite/api/campaigns
Content-Type: application/json

{
  "name": "My Newsletter",
  "type": "regular",
  "emails": [
    {
      "subject": "Weekly Update",
      "from_name": "Newsletter",
      "from": "newsletter@example.com"
    }
  ],
  "groups": ["12345678901234567"]
}
```

#### Schedule Campaign

```bash
POST /mailerlite/api/campaigns/{campaign_id}/schedule
Content-Type: application/json

{
  "delivery": "instant"
}
```

#### Delete Campaign

```bash
DELETE /mailerlite/api/campaigns/{campaign_id}
```

### Automations

#### List Automations

```bash
GET /mailerlite/api/automations
```

Query parameters: `filter[enabled]`, `filter[name]`, `page`, `limit`

#### Get Automation

```bash
GET /mailerlite/api/automations/{automation_id}
```

#### Delete Automation

```bash
DELETE /mailerlite/api/automations/{automation_id}
```

### Fields

#### List Fields

```bash
GET /mailerlite/api/fields
```

#### Create Field

```bash
POST /mailerlite/api/fields
Content-Type: application/json

{
  "name": "Company",
  "type": "text"
}
```

### Segments

#### List Segments

```bash
GET /mailerlite/api/segments
```

#### Get Segment Subscribers

```bash
GET /mailerlite/api/segments/{segment_id}/subscribers
```

### Forms

#### List Forms

```bash
GET /mailerlite/api/forms/{type}
```

Path parameters: `type` - `popup`, `embedded`, or `promotion`

#### Get Form Subscribers

```bash
GET /mailerlite/api/forms/{form_id}/subscribers
```

### Webhooks

#### List Webhooks

```bash
GET /mailerlite/api/webhooks
```

#### Create Webhook

```bash
POST /mailerlite/api/webhooks
Content-Type: application/json

{
  "name": "Subscriber Updates",
  "events": ["subscriber.created", "subscriber.updated"],
  "url": "https://example.com/webhook"
}
```

## Notes

- Rate limit: 120 requests per minute
- Subscriber emails serve as unique identifiers (POST creates or updates existing)
- Only draft campaigns can be updated
- Pagination: cursor-based for subscribers, page-based for groups/campaigns
- API versioning can be overridden via `X-Version: YYYY-MM-DD` header

## Resources

- [MailerLite API Documentation](https://developers.mailerlite.com/docs/)
- [MailerLite Subscribers API](https://developers.mailerlite.com/docs/subscribers.html)
- [MailerLite Groups API](https://developers.mailerlite.com/docs/groups.html)
- [MailerLite Campaigns API](https://developers.mailerlite.com/docs/campaigns.html)
