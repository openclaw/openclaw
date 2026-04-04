# SignNow Routing Reference

**App name:** `signnow`
**Base URL proxied:** `api.signnow.com`

## API Path Pattern

```
/signnow/{resource}
```

## Common Endpoints

### User

```bash
GET /signnow/user
GET /signnow/user/documents
```

### Documents

```bash
# Upload document (multipart form data)
POST /signnow/document

# Get document
GET /signnow/document/{document_id}

# Update document
PUT /signnow/document/{document_id}

# Download document
GET /signnow/document/{document_id}/download?type=collapsed

# Get document history
GET /signnow/document/{document_id}/historyfull

# Move document to folder
POST /signnow/document/{document_id}/move

# Merge documents (returns PDF)
POST /signnow/document/merge

# Delete document
DELETE /signnow/document/{document_id}
```

### Templates

```bash
# Create template from document
POST /signnow/template

# Create document from template
POST /signnow/template/{template_id}/copy
```

### Invites

```bash
# Send freeform invite
POST /signnow/document/{document_id}/invite

# Create signing link (requires document fields)
POST /signnow/link
```

### Folders

```bash
GET /signnow/folder
GET /signnow/folder/{folder_id}
```

### Webhooks (Event Subscriptions)

```bash
GET /signnow/event_subscription
POST /signnow/event_subscription
DELETE /signnow/event_subscription/{subscription_id}
```

## Notes

- Documents must be uploaded as multipart form data with PDF file
- Supported file types: PDF, DOC, DOCX, ODT, RTF, PNG, JPG
- System folders cannot be renamed or deleted
- Creating signing links requires documents to have signature fields
- Custom invite subject/message requires paid subscription
- Rate limit in development mode: 500 requests/hour per application

## Resources

- [SignNow API Reference](https://docs.signnow.com/docs/signnow/reference)
- [SignNow Developer Portal](https://www.signnow.com/developers)
