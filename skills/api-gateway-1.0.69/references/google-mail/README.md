# Gmail Routing Reference

**App name:** `google-mail`
**Base URL proxied:** `gmail.googleapis.com`

## API Path Pattern

```
/google-mail/gmail/v1/users/me/{endpoint}
```

## Common Endpoints

### List Messages

```bash
GET /google-mail/gmail/v1/users/me/messages?maxResults=10
```

With query filter:

```bash
GET /google-mail/gmail/v1/users/me/messages?q=is:unread&maxResults=10
```

### Get Message

```bash
GET /google-mail/gmail/v1/users/me/messages/{messageId}
```

With metadata only:

```bash
GET /google-mail/gmail/v1/users/me/messages/{messageId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date
```

### Send Message

```bash
POST /google-mail/gmail/v1/users/me/messages/send
Content-Type: application/json

{
  "raw": "BASE64_ENCODED_EMAIL"
}
```

### List Labels

```bash
GET /google-mail/gmail/v1/users/me/labels
```

### List Threads

```bash
GET /google-mail/gmail/v1/users/me/threads?maxResults=10
```

### Get Thread

```bash
GET /google-mail/gmail/v1/users/me/threads/{threadId}
```

### Modify Message Labels

```bash
POST /google-mail/gmail/v1/users/me/messages/{messageId}/modify
Content-Type: application/json

{
  "addLabelIds": ["STARRED"],
  "removeLabelIds": ["UNREAD"]
}
```

### Trash Message

```bash
POST /google-mail/gmail/v1/users/me/messages/{messageId}/trash
```

### Create Draft

```bash
POST /google-mail/gmail/v1/users/me/drafts
Content-Type: application/json

{
  "message": {
    "raw": "BASE64URL_ENCODED_EMAIL"
  }
}
```

### Update Draft

```bash
PUT /google-mail/gmail/v1/users/me/drafts/{draftId}
Content-Type: application/json

{
  "message": {
    "raw": "BASE64URL_ENCODED_EMAIL"
  }
}
```

### Send Draft

```bash
POST /google-mail/gmail/v1/users/me/drafts/send
Content-Type: application/json

{
  "id": "{draftId}"
}
```

### Get Profile

```bash
GET /google-mail/gmail/v1/users/me/profile
```

## Query Operators

Use in the `q` parameter:

- `is:unread` - Unread messages
- `is:starred` - Starred messages
- `from:email@example.com` - From specific sender
- `to:email@example.com` - To specific recipient
- `subject:keyword` - Subject contains keyword
- `after:2024/01/01` - After date
- `before:2024/12/31` - Before date
- `has:attachment` - Has attachments

## Notes

- Authentication is automatic - the router injects the OAuth token
- Use `me` as userId for the authenticated user
- Message body is base64url encoded in the `raw` field

## Resources

- [API Overview](https://developers.google.com/gmail/api/reference/rest)
- [List Messages](https://developers.google.com/gmail/api/reference/rest/v1/users.messages/list)
- [Get Message](https://developers.google.com/gmail/api/reference/rest/v1/users.messages/get)
- [Send Message](https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send)
- [Modify Message Labels](https://developers.google.com/gmail/api/reference/rest/v1/users.messages/modify)
- [Trash Message](https://developers.google.com/gmail/api/reference/rest/v1/users.messages/trash)
- [List Threads](https://developers.google.com/gmail/api/reference/rest/v1/users.threads/list)
- [Get Thread](https://developers.google.com/gmail/api/reference/rest/v1/users.threads/get)
- [List Labels](https://developers.google.com/gmail/api/reference/rest/v1/users.labels/list)
- [Create Draft](https://developers.google.com/gmail/api/reference/rest/v1/users.drafts/create)
- [Update Draft](https://developers.google.com/gmail/api/reference/rest/v1/users.drafts/update)
- [Send Draft](https://developers.google.com/gmail/api/reference/rest/v1/users.drafts/send)
- [Get Profile](https://developers.google.com/gmail/api/reference/rest/v1/users/getProfile)
