# Outlook Routing Reference

**App name:** `outlook`
**Base URL proxied:** `graph.microsoft.com`

## API Path Pattern

```
/outlook/v1.0/me/{resource}
```

## Common Endpoints

### User Profile

```bash
GET /outlook/v1.0/me
```

### Mail Folders

#### List Mail Folders

```bash
GET /outlook/v1.0/me/mailFolders
```

Well-known folder names: `Inbox`, `Drafts`, `SentItems`, `DeletedItems`, `Archive`, `JunkEmail`

#### Get Mail Folder

```bash
GET /outlook/v1.0/me/mailFolders/{folderId}
```

#### Create Mail Folder

```bash
POST /outlook/v1.0/me/mailFolders
Content-Type: application/json

{
  "displayName": "My Folder"
}
```

### Messages

#### List Messages

```bash
GET /outlook/v1.0/me/messages
```

From specific folder:

```bash
GET /outlook/v1.0/me/mailFolders/Inbox/messages
```

With filter:

```bash
GET /outlook/v1.0/me/messages?$filter=isRead eq false&$top=10
```

#### Get Message

```bash
GET /outlook/v1.0/me/messages/{messageId}
```

#### Send Message

```bash
POST /outlook/v1.0/me/sendMail
Content-Type: application/json

{
  "message": {
    "subject": "Hello",
    "body": {
      "contentType": "Text",
      "content": "This is the email body."
    },
    "toRecipients": [
      {
        "emailAddress": {
          "address": "recipient@example.com"
        }
      }
    ]
  },
  "saveToSentItems": true
}
```

#### Create Draft

```bash
POST /outlook/v1.0/me/messages
Content-Type: application/json

{
  "subject": "Hello",
  "body": {
    "contentType": "Text",
    "content": "This is the email body."
  },
  "toRecipients": [
    {
      "emailAddress": {
        "address": "recipient@example.com"
      }
    }
  ]
}
```

#### Send Existing Draft

```bash
POST /outlook/v1.0/me/messages/{messageId}/send
```

#### Update Message (Mark as Read)

```bash
PATCH /outlook/v1.0/me/messages/{messageId}
Content-Type: application/json

{
  "isRead": true
}
```

#### Delete Message

```bash
DELETE /outlook/v1.0/me/messages/{messageId}
```

#### Move Message

```bash
POST /outlook/v1.0/me/messages/{messageId}/move
Content-Type: application/json

{
  "destinationId": "{folderId}"
}
```

### Calendar

#### List Calendars

```bash
GET /outlook/v1.0/me/calendars
```

#### List Events

```bash
GET /outlook/v1.0/me/calendar/events
```

With filter:

```bash
GET /outlook/v1.0/me/calendar/events?$filter=start/dateTime ge '2024-01-01'&$top=10
```

#### Create Event

```bash
POST /outlook/v1.0/me/calendar/events
Content-Type: application/json

{
  "subject": "Meeting",
  "start": {
    "dateTime": "2024-01-15T10:00:00",
    "timeZone": "UTC"
  },
  "end": {
    "dateTime": "2024-01-15T11:00:00",
    "timeZone": "UTC"
  },
  "attendees": [
    {
      "emailAddress": {
        "address": "attendee@example.com"
      },
      "type": "required"
    }
  ]
}
```

#### Delete Event

```bash
DELETE /outlook/v1.0/me/events/{eventId}
```

### Contacts

#### List Contacts

```bash
GET /outlook/v1.0/me/contacts
```

#### Create Contact

```bash
POST /outlook/v1.0/me/contacts
Content-Type: application/json

{
  "givenName": "John",
  "surname": "Doe",
  "emailAddresses": [
    {
      "address": "john.doe@example.com"
    }
  ]
}
```

#### Delete Contact

```bash
DELETE /outlook/v1.0/me/contacts/{contactId}
```

## OData Query Parameters

- `$top=10` - Limit results
- `$skip=20` - Skip results (pagination)
- `$select=subject,from` - Select specific fields
- `$filter=isRead eq false` - Filter results
- `$orderby=receivedDateTime desc` - Sort results
- `$search="keyword"` - Search content

## Notes

- Use `me` as the user identifier for the authenticated user
- Message body content types: `Text` or `HTML`
- Well-known folder names work as folder IDs: `Inbox`, `Drafts`, `SentItems`, etc.
- Calendar events use ISO 8601 datetime format

## Resources

- [Microsoft Graph API Overview](https://learn.microsoft.com/en-us/graph/api/overview)
- [Mail API](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview)
- [Calendar API](https://learn.microsoft.com/en-us/graph/api/resources/calendar)
- [Contacts API](https://learn.microsoft.com/en-us/graph/api/resources/contact)
- [Query Parameters](https://learn.microsoft.com/en-us/graph/query-parameters)
