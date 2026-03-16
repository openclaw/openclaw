---
name: blink-microsoft
description: >
  Access Microsoft 365 services: Outlook email, Teams messages, OneDrive files,
  and Calendar events. Use when asked to check email, send messages, manage
  files, or schedule meetings via Microsoft. Requires a linked Microsoft connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "microsoft" } }
---

# Blink Microsoft

Access Microsoft 365 (Outlook, Teams, OneDrive, Calendar). Provider key: `microsoft`.

## Get user profile
```bash
bash scripts/call.sh microsoft /me GET
```

## List Outlook emails (inbox)
```bash
bash scripts/call.sh microsoft /me/messages GET \
  '{"$top": 20, "$filter": "isRead eq false", "$orderby": "receivedDateTime desc"}'
```

## Search emails
```bash
bash scripts/call.sh microsoft /me/messages GET \
  '{"$search": "\"project deadline\"", "$top": 10}'
```

## Send an email
```bash
bash scripts/call.sh microsoft /me/sendMail POST '{
  "message": {
    "subject": "Hello from your agent",
    "body": {"contentType": "Text", "content": "Message body here"},
    "toRecipients": [{"emailAddress": {"address": "recipient@example.com"}}]
  }
}'
```

## List calendar events
```bash
bash scripts/call.sh microsoft /me/events GET \
  '{"$top": 20, "$orderby": "start/dateTime", "$filter": "start/dateTime ge '"'"'2026-03-15T00:00:00'"'"'"}'
```

## Create a calendar event
```bash
bash scripts/call.sh microsoft /me/events POST '{
  "subject": "Team Standup",
  "start": {"dateTime": "2026-03-20T10:00:00", "timeZone": "UTC"},
  "end": {"dateTime": "2026-03-20T10:30:00", "timeZone": "UTC"},
  "attendees": [{"emailAddress": {"address": "colleague@company.com"}, "type": "required"}]
}'
```

## List OneDrive files
```bash
bash scripts/call.sh microsoft /me/drive/root/children GET \
  '{"$top": 30, "$select": "name,id,size,lastModifiedDateTime,webUrl"}'
```

## Search OneDrive
```bash
bash scripts/call.sh microsoft /me/drive/root/search(q='report') GET
```

## List Teams
```bash
bash scripts/call.sh microsoft /me/joinedTeams GET
```

## Send Teams message
```bash
bash scripts/call.sh microsoft /teams/TEAM_ID/channels/CHANNEL_ID/messages POST '{
  "body": {"content": "Hello from your agent!"}
}'
```

## Common use cases
- "Check my unread Outlook emails" → list messages with isRead filter
- "Schedule a meeting with Alice for Thursday" → create calendar event
- "What files are in my OneDrive?" → list drive root children
- "Send the weekly report to my team" → send email
- "Post a message in the general Teams channel" → send Teams message
