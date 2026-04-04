# ActiveCampaign Routing Reference

**App name:** `active-campaign`
**Base URL proxied:** `{account}.api-us1.com`

## API Path Pattern

```
/active-campaign/api/3/{resource}
```

## Common Endpoints

### Contacts

#### List Contacts

```bash
GET /active-campaign/api/3/contacts
```

#### Get Contact

```bash
GET /active-campaign/api/3/contacts/{contactId}
```

#### Create Contact

```bash
POST /active-campaign/api/3/contacts
Content-Type: application/json

{
  "contact": {
    "email": "user@example.com",
    "firstName": "John",
    "lastName": "Doe"
  }
}
```

#### Update Contact

```bash
PUT /active-campaign/api/3/contacts/{contactId}
```

#### Delete Contact

```bash
DELETE /active-campaign/api/3/contacts/{contactId}
```

### Tags

#### List Tags

```bash
GET /active-campaign/api/3/tags
```

#### Create Tag

```bash
POST /active-campaign/api/3/tags
Content-Type: application/json

{
  "tag": {
    "tag": "Tag Name",
    "tagType": "contact"
  }
}
```

### Contact Tags

#### Add Tag to Contact

```bash
POST /active-campaign/api/3/contactTags
Content-Type: application/json

{
  "contactTag": {
    "contact": "1",
    "tag": "1"
  }
}
```

#### Remove Tag from Contact

```bash
DELETE /active-campaign/api/3/contactTags/{contactTagId}
```

### Lists

#### List All Lists

```bash
GET /active-campaign/api/3/lists
```

#### Create List

```bash
POST /active-campaign/api/3/lists
```

### Deals

#### List Deals

```bash
GET /active-campaign/api/3/deals
```

#### Create Deal

```bash
POST /active-campaign/api/3/deals
Content-Type: application/json

{
  "deal": {
    "title": "New Deal",
    "value": "10000",
    "currency": "usd",
    "contact": "1",
    "stage": "1"
  }
}
```

### Deal Stages & Pipelines

#### List Deal Stages

```bash
GET /active-campaign/api/3/dealStages
```

#### List Pipelines (Deal Groups)

```bash
GET /active-campaign/api/3/dealGroups
```

### Automations

#### List Automations

```bash
GET /active-campaign/api/3/automations
```

### Campaigns

#### List Campaigns

```bash
GET /active-campaign/api/3/campaigns
```

### Users

#### List Users

```bash
GET /active-campaign/api/3/users
```

### Accounts

#### List Accounts

```bash
GET /active-campaign/api/3/accounts
```

### Custom Fields

#### List Fields

```bash
GET /active-campaign/api/3/fields
```

### Notes

#### List Notes

```bash
GET /active-campaign/api/3/notes
```

### Webhooks

#### List Webhooks

```bash
GET /active-campaign/api/3/webhooks
```

## Pagination

Uses offset-based pagination:

```bash
GET /active-campaign/api/3/contacts?limit=20&offset=0
```

**Parameters:**

- `limit` - Results per page (default: 20)
- `offset` - Starting index

Response includes meta with total:

```json
{
  "contacts": [...],
  "meta": {
    "total": "150"
  }
}
```

## Notes

- All endpoints require `/api/3/` prefix
- Request bodies use singular resource names (e.g., `{"contact": {...}}`)
- IDs returned as strings
- Rate limit: 5 requests per second per account
- DELETE returns 200 OK (not 204)

## Resources

- [ActiveCampaign API Overview](https://developers.activecampaign.com/reference/overview)
- [Developer Portal](https://developers.activecampaign.com/)
- [Contacts API](https://developers.activecampaign.com/reference/list-all-contacts)
