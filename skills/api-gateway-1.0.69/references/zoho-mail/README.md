# Zoho Mail Routing Reference

**App name:** `zoho-mail`
**Base URL proxied:** `mail.zoho.com`

## API Path Pattern

```
/zoho-mail/api/{resource}
```

## Common Endpoints

### Accounts

```bash
# Get all accounts
GET /zoho-mail/api/accounts

# Get account details
GET /zoho-mail/api/accounts/{accountId}
```

### Folders

```bash
# List all folders
GET /zoho-mail/api/accounts/{accountId}/folders

# Create folder
POST /zoho-mail/api/accounts/{accountId}/folders
Content-Type: application/json

{
  "folderName": "My Folder"
}

# Rename folder
PUT /zoho-mail/api/accounts/{accountId}/folders/{folderId}
Content-Type: application/json

{
  "folderName": "Renamed Folder"
}

# Delete folder
DELETE /zoho-mail/api/accounts/{accountId}/folders/{folderId}
```

### Labels

```bash
# List labels
GET /zoho-mail/api/accounts/{accountId}/labels

# Create label
POST /zoho-mail/api/accounts/{accountId}/labels
Content-Type: application/json

{
  "labelName": "Important"
}

# Update label
PUT /zoho-mail/api/accounts/{accountId}/labels/{labelId}

# Delete label
DELETE /zoho-mail/api/accounts/{accountId}/labels/{labelId}
```

### Messages

```bash
# List emails in folder
GET /zoho-mail/api/accounts/{accountId}/messages/view?folderId={folderId}&limit=50

# Search emails
GET /zoho-mail/api/accounts/{accountId}/messages/search?searchKey={query}

# Get email content
GET /zoho-mail/api/accounts/{accountId}/folders/{folderId}/messages/{messageId}/content

# Get email headers
GET /zoho-mail/api/accounts/{accountId}/folders/{folderId}/messages/{messageId}/header

# Get email metadata
GET /zoho-mail/api/accounts/{accountId}/folders/{folderId}/messages/{messageId}/details

# Get original MIME message
GET /zoho-mail/api/accounts/{accountId}/messages/{messageId}/originalmessage

# Send email
POST /zoho-mail/api/accounts/{accountId}/messages
Content-Type: application/json

{
  "fromAddress": "sender@yourdomain.com",
  "toAddress": "recipient@example.com",
  "subject": "Subject",
  "content": "Email body",
  "mailFormat": "html"
}

# Reply to email
POST /zoho-mail/api/accounts/{accountId}/messages/{messageId}

# Update message (mark read, move, flag, archive, spam)
PUT /zoho-mail/api/accounts/{accountId}/updatemessage
Content-Type: application/json

{
  "messageId": ["messageId1"],
  "folderId": "folderId",
  "mode": "markAsRead"
}

# Delete email
DELETE /zoho-mail/api/accounts/{accountId}/folders/{folderId}/messages/{messageId}
```

### Attachments

```bash
# Upload attachment
POST /zoho-mail/api/accounts/{accountId}/messages/attachments
Content-Type: multipart/form-data

# Get attachment info
GET /zoho-mail/api/accounts/{accountId}/folders/{folderId}/messages/{messageId}/attachmentinfo

# Download attachment
GET /zoho-mail/api/accounts/{accountId}/folders/{folderId}/messages/{messageId}/attachments/{attachmentId}
```

## Update Message Modes

| Mode           | Description                             |
| -------------- | --------------------------------------- |
| `markAsRead`   | Mark messages as read                   |
| `markAsUnread` | Mark messages as unread                 |
| `moveMessage`  | Move messages (requires `destfolderId`) |
| `flag`         | Set flag (requires `flagid`: 1-4)       |
| `archive`      | Archive messages                        |
| `unArchive`    | Unarchive messages                      |
| `spam`         | Mark as spam                            |
| `notSpam`      | Mark as not spam                        |

## Default Folders

| Folder    | Type        |
| --------- | ----------- |
| Inbox     | `Inbox`     |
| Drafts    | `Drafts`    |
| Templates | `Templates` |
| Snoozed   | `Snoozed`   |
| Sent      | `Sent`      |
| Spam      | `Spam`      |
| Trash     | `Trash`     |
| Outbox    | `Outbox`    |

## Notes

- Account IDs are required for most operations - get via `/api/accounts`
- Message IDs and Folder IDs are numeric strings
- The `fromAddress` must be associated with the authenticated account
- Uses offset-based pagination with `start` and `limit` parameters
- Some operations require additional OAuth scopes

## Resources

- [Zoho Mail API Overview](https://www.zoho.com/mail/help/api/overview.html)
- [Email Messages API](https://www.zoho.com/mail/help/api/email-api.html)
- [Folders API](https://www.zoho.com/mail/help/api/get-all-folder-details.html)
