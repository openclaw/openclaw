# GetResponse Routing Reference

**App name:** `getresponse`
**Base URL proxied:** `api.getresponse.com`

## API Path Pattern

```
/getresponse/v3/{resource}
```

## Common Endpoints

### Get Account Details

```bash
GET /getresponse/v3/accounts
```

### List Campaigns

```bash
GET /getresponse/v3/campaigns
```

Query parameters:

- `page` - Page number (starts at 1)
- `perPage` - Records per page (max 1000)

### Get Campaign

```bash
GET /getresponse/v3/campaigns/{campaignId}
```

### Create Campaign

```bash
POST /getresponse/v3/campaigns
Content-Type: application/json

{
  "name": "My Campaign"
}
```

### List Contacts

```bash
GET /getresponse/v3/contacts?page=1&perPage=100
```

Query parameters:

- `query[campaignId]` - Filter by campaign
- `query[email]` - Filter by email
- `sort[createdOn]` - Sort by creation date (asc/desc)

### Get Contact

```bash
GET /getresponse/v3/contacts/{contactId}
```

### Create Contact

```bash
POST /getresponse/v3/contacts
Content-Type: application/json

{
  "email": "user@example.com",
  "name": "John Doe",
  "campaign": {
    "campaignId": "abc123"
  }
}
```

### Update Contact

```bash
POST /getresponse/v3/contacts/{contactId}
Content-Type: application/json

{
  "name": "Jane Doe"
}
```

### Delete Contact

```bash
DELETE /getresponse/v3/contacts/{contactId}
```

### List Custom Fields

```bash
GET /getresponse/v3/custom-fields
```

### List Tags

```bash
GET /getresponse/v3/tags
```

### Create Tag

```bash
POST /getresponse/v3/tags
Content-Type: application/json

{
  "name": "VIP Customer"
}
```

### List Segments

```bash
GET /getresponse/v3/search-contacts
```

### Get Contacts from Segment

```bash
GET /getresponse/v3/search-contacts/{searchContactId}/contacts
```

### Send Newsletter

```bash
POST /getresponse/v3/newsletters
Content-Type: application/json

{
  "subject": "Newsletter Subject",
  "name": "Internal Name",
  "campaign": {
    "campaignId": "abc123"
  },
  "content": {
    "html": "<html><body>Content</body></html>",
    "plain": "Content"
  },
  "sendOn": "2026-02-15T10:00:00Z"
}
```

### List Autoresponders

```bash
GET /getresponse/v3/autoresponders
```

### List From Fields

```bash
GET /getresponse/v3/from-fields
```

## Notes

- Campaign IDs and Contact IDs are alphanumeric strings (e.g., "fZ0Xg", "VZ4Sa5g")
- Timestamps are in ISO 8601 format
- Field names use camelCase
- Use page-based pagination with `page` and `perPage` parameters
- Rate limits: 30,000 requests per 10 minutes, 80 requests per second
- "Campaigns" in GetResponse are equivalent to email lists/audiences
- "Search contacts" and "segments" refer to the same resource

## Resources

- [GetResponse API Documentation](https://apidocs.getresponse.com/v3)
- [GetResponse OpenAPI Spec](https://apireference.getresponse.com/open-api.json)
- [GetResponse Help Center](https://www.getresponse.com/help)
