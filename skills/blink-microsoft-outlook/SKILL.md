---
name: blink-microsoft-outlook
description: >
  Read, send, and manage emails in Microsoft Outlook via the Microsoft Graph API.
  Use when asked to check emails, send messages, search inbox, or manage mail
  folders. Requires a linked Microsoft connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "microsoft_outlook" } }
---

# Blink Microsoft Outlook

Access Outlook email via Microsoft Graph API. Provider key: `microsoft_outlook`.

## List inbox messages
```bash
bash scripts/call.sh microsoft_outlook /me/messages GET \
  '{"$top":"20","$select":"subject,from,receivedDateTime,isRead","$orderby":"receivedDateTime desc"}'
```

## Search emails
```bash
bash scripts/call.sh microsoft_outlook /me/messages GET \
  '{"$search":"\"project update\"","$select":"subject,from,receivedDateTime"}'
```

## Send email
```bash
bash scripts/call.sh microsoft_outlook /me/sendMail POST '{
  "message": {
    "subject": "Hello",
    "body": {"contentType": "Text", "content": "Hi there"},
    "toRecipients": [{"emailAddress": {"address": "user@example.com"}}]
  }
}'
```

## Get mail folders
```bash
bash scripts/call.sh microsoft_outlook /me/mailFolders GET
```

## Mark message as read
```bash
bash scripts/call.sh microsoft_outlook /me/messages/{id} PATCH '{"isRead":true}'
```

## Move message to folder
```bash
bash scripts/call.sh microsoft_outlook /me/messages/{id}/move POST \
  '{"destinationId":"archive"}'
```

## Delete message
```bash
bash scripts/call.sh microsoft_outlook /me/messages/{id} DELETE
```

## Common use cases
- "Check my unread emails" → list messages with `$filter: "isRead eq false"`
- "Send Alice an update" → sendMail POST
- "Find emails about the contract" → search with `$search`
- "What folders do I have?" → list mailFolders
- "Mark that email as read" → PATCH isRead true
