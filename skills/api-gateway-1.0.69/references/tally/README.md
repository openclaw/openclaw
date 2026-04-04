# Tally Routing Reference

**App name:** `tally`
**Base URL proxied:** `api.tally.so`

## API Path Pattern

```
/tally/{resource}
```

Tally's API does not use version prefixes in paths.

## Required Headers

THe `User-Agent` header is required to avoid Cloudflare blocks:

```
User-Agent: Maton/1.0
```

## Common Endpoints

### Get Current User

```bash
GET /tally/users/me
```

### List Forms

```bash
GET /tally/forms
```

**Query Parameters:**

- `page` - Page number (default: 1)
- `limit` - Items per page (default: 50)

### Get Form

```bash
GET /tally/forms/{formId}
```

### Create Form

```bash
POST /tally/forms
Content-Type: application/json

{
  "status": "DRAFT",
  "blocks": [
    {
      "type": "FORM_TITLE",
      "uuid": "11111111-1111-1111-1111-111111111111",
      "groupUuid": "22222222-2222-2222-2222-222222222222",
      "groupType": "FORM_TITLE",
      "title": "My Form",
      "payload": {}
    },
    {
      "type": "INPUT_TEXT",
      "uuid": "33333333-3333-3333-3333-333333333333",
      "groupUuid": "44444444-4444-4444-4444-444444444444",
      "groupType": "INPUT_TEXT",
      "title": "Your name",
      "payload": {}
    }
  ]
}
```

### Update Form

```bash
PATCH /tally/forms/{formId}
Content-Type: application/json

{
  "name": "Updated Form Name",
  "status": "PUBLISHED"
}
```

### Delete Form

```bash
DELETE /tally/forms/{formId}
```

### List Form Questions

```bash
GET /tally/forms/{formId}/questions
```

### List Form Submissions

```bash
GET /tally/forms/{formId}/submissions
```

**Query Parameters:**

- `page` - Page number
- `limit` - Items per page
- `startDate` - Filter by start date (ISO 8601)
- `endDate` - Filter by end date (ISO 8601)
- `afterId` - Cursor for pagination

### Get Submission

```bash
GET /tally/forms/{formId}/submissions/{submissionId}
```

### Delete Submission

```bash
DELETE /tally/forms/{formId}/submissions/{submissionId}
```

### List Workspaces

```bash
GET /tally/workspaces
```

### Get Workspace

```bash
GET /tally/workspaces/{workspaceId}
```

### Create Workspace

```bash
POST /tally/workspaces
Content-Type: application/json

{
  "name": "New Workspace"
}
```

### List Organization Users

```bash
GET /tally/organizations/{organizationId}/users
```

### List Organization Invites

```bash
GET /tally/organizations/{organizationId}/invites
```

### List Webhooks

```bash
GET /tally/webhooks
```

### Create Webhook

```bash
POST /tally/webhooks
Content-Type: application/json

{
  "formId": "GxdRaQ",
  "url": "https://your-endpoint.com/webhook",
  "eventTypes": ["FORM_RESPONSE"]
}
```

## Notes

- Form and workspace IDs are short alphanumeric strings (e.g., `GxdRaQ`, `3jW9Q1`)
- Block `uuid` and `groupUuid` fields must be valid UUIDs (GUIDs)
- Page-based pagination with `page` and `limit` parameters
- Rate limit: 100 requests per minute
- API is in public beta and subject to changes
- Creating workspaces requires a Pro subscription

## Resources

- [Tally API Introduction](https://developers.tally.so/api-reference/introduction)
- [Tally API Reference](https://developers.tally.so/llms.txt)
- [Tally Help Center](https://help.tally.so/)
