# Typeform Routing Reference

**App name:** `typeform`
**Base URL proxied:** `api.typeform.com`

## API Path Pattern

```
/typeform/{endpoint}
```

## Common Endpoints

### User

#### Get Current User

```bash
GET /typeform/me
```

### Forms

#### List Forms

```bash
GET /typeform/forms?page_size=10
```

#### Get Form

```bash
GET /typeform/forms/{formId}
```

#### Create Form

```bash
POST /typeform/forms
Content-Type: application/json

{
  "title": "Customer Survey",
  "fields": [
    {
      "type": "short_text",
      "title": "What is your name?"
    },
    {
      "type": "email",
      "title": "What is your email?"
    }
  ]
}
```

#### Update Form (Full Replace)

```bash
PUT /typeform/forms/{formId}
Content-Type: application/json

{
  "title": "Updated Survey Title",
  "fields": [...]
}
```

#### Update Form (Partial - PATCH)

```bash
PATCH /typeform/forms/{formId}
Content-Type: application/json

[
  {"op": "replace", "path": "/title", "value": "New Title"}
]
```

#### Delete Form

```bash
DELETE /typeform/forms/{formId}
```

### Responses

#### List Responses

```bash
GET /typeform/forms/{formId}/responses?page_size=25
```

With filters:

```bash
GET /typeform/forms/{formId}/responses?since=2024-01-01T00:00:00Z&until=2024-12-31T23:59:59Z
```

Completed only:

```bash
GET /typeform/forms/{formId}/responses?completed=true
```

#### Delete Response

```bash
DELETE /typeform/forms/{formId}/responses?included_response_ids={responseId}
```

### Insights

#### Get Form Insights

```bash
GET /typeform/insights/{formId}/summary
```

### Workspaces

#### List Workspaces

```bash
GET /typeform/workspaces
```

#### Get Workspace

```bash
GET /typeform/workspaces/{workspaceId}
```

### Themes

#### List Themes

```bash
GET /typeform/themes
```

### Images

#### List Images

```bash
GET /typeform/images
```

## Field Types

- `short_text` - Single line text
- `long_text` - Multi-line text
- `email` - Email address
- `number` - Numeric input
- `rating` - Star rating
- `opinion_scale` - 0-10 scale
- `multiple_choice` - Single or multiple selection
- `yes_no` - Boolean
- `date` - Date picker
- `file_upload` - File attachment
- `dropdown` - Dropdown selection

## Notes

- Form IDs are alphanumeric strings (e.g., `JiLEvIgv`)
- Response pagination uses `before` token for cursor-based pagination
- Timestamps are in ISO 8601 format (e.g., `2026-01-01T00:00:00Z`)
- Responses include `answers` array with field references
- DELETE operations return HTTP 204 (no content) on success
- PATCH uses JSON Patch format (array of operations with `op`, `path`, `value`)

## Resources

- [API Overview](https://www.typeform.com/developers/get-started)
- [List Forms](https://www.typeform.com/developers/create/reference/retrieve-forms)
- [Get Form](https://www.typeform.com/developers/create/reference/retrieve-form)
- [Create Form](https://www.typeform.com/developers/create/reference/create-form)
- [Update Form](https://www.typeform.com/developers/create/reference/update-form)
- [Update Form Patch](https://www.typeform.com/developers/create/reference/update-form-patch)
- [Delete Form](https://www.typeform.com/developers/create/reference/delete-form)
- [Get Form Messages](https://www.typeform.com/developers/create/reference/retrieve-custom-form-messages)
- [Update Form Messages](https://www.typeform.com/developers/create/reference/update-custom-messages)
- [List Responses](https://www.typeform.com/developers/responses/reference/retrieve-responses)
- [Delete Responses](https://www.typeform.com/developers/responses/reference/delete-responses)
- [List Workspaces](https://www.typeform.com/developers/create/reference/retrieve-workspaces)
- [Get Workspace](https://www.typeform.com/developers/create/reference/retrieve-workspace)
- [Create Workspace](https://www.typeform.com/developers/create/reference/create-workspace)
- [Update Workspace](https://www.typeform.com/developers/create/reference/update-workspace)
- [Delete Workspace](https://www.typeform.com/developers/create/reference/delete-workspace)
- [List Themes](https://www.typeform.com/developers/create/reference/retrieve-themes)
- [Get Theme](https://www.typeform.com/developers/create/reference/retrieve-theme)
- [Create Theme](https://www.typeform.com/developers/create/reference/create-theme)
- [Update Theme](https://www.typeform.com/developers/create/reference/update-theme-partial-update)
- [Delete Theme](https://www.typeform.com/developers/create/reference/delete-theme)
- [Get Image](https://www.typeform.com/developers/create/reference/retrieve-image)
- [Get Image By Size](https://www.typeform.com/developers/create/reference/retrieve-image-by-size)
- [Create Image](https://www.typeform.com/developers/create/reference/create-image)
- [Delete Image](https://www.typeform.com/developers/create/reference/delete-image)
- [Create Or Update Webhook](https://www.typeform.com/developers/webhooks/reference/create-or-update-webhook)
- [Get Webhook](https://www.typeform.com/developers/webhooks/reference/retrieve-single-webhook)
- [Delete Webhook](https://www.typeform.com/developers/webhooks/reference/delete-webhook)
