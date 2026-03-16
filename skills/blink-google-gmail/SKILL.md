---
name: blink-google-gmail
description: >
  Read, search, send, and manage Gmail emails and labels. Use when asked to
  check email, compose or send messages, search inbox, organize with labels,
  or manage email threads. Requires a linked Google connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "google_gmail" } }
---

# Blink Gmail

Access the user's Gmail inbox. Provider key: `google_gmail`.

## List messages (inbox)
```bash
bash scripts/call.sh google_gmail /users/me/messages GET \
  '{"labelIds": "INBOX", "maxResults": 20}'
```

## Search messages
```bash
bash scripts/call.sh google_gmail /users/me/messages GET \
  '{"q": "from:boss@company.com is:unread", "maxResults": 10}'
```

## Get full message content
```bash
bash scripts/call.sh google_gmail /users/me/messages/MESSAGE_ID GET \
  '{"format": "full"}'
```

## Send an email
```bash
bash scripts/call.sh google_gmail /users/me/messages/send POST '{
  "raw": "'$(echo -e "To: recipient@example.com\r\nSubject: Hello\r\nContent-Type: text/plain\r\n\r\nHello from your agent!" | base64 -w 0 | tr '+/' '-_' | tr -d '=')'"
}'
```

## List labels
```bash
bash scripts/call.sh google_gmail /users/me/labels GET
```

## Modify message labels (mark as read)
```bash
bash scripts/call.sh google_gmail /users/me/messages/MESSAGE_ID/modify POST '{
  "removeLabelIds": ["UNREAD"]
}'
```

## Move to trash
```bash
bash scripts/call.sh google_gmail /users/me/messages/MESSAGE_ID/trash POST '{}'
```

## List threads
```bash
bash scripts/call.sh google_gmail /users/me/threads GET \
  '{"labelIds": "INBOX", "maxResults": 10}'
```

## Get a thread
```bash
bash scripts/call.sh google_gmail /users/me/threads/THREAD_ID GET
```

## Common use cases
- "Check my unread emails" → list messages with `q: "is:unread"` filter
- "What emails did I get from Sarah today?" → search `from:sarah@... after:today`
- "Send John a meeting confirmation" → compose and send email
- "Mark all emails from newsletter as read" → list + modify each
- "What's the latest update on project X?" → search for "project X" in inbox
- "Archive old emails" → modify labels to remove INBOX
