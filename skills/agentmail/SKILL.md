---
name: agentmail
description: Send and receive emails using AgentMail.
requires:
  env:
    - AGENTMAIL_API_KEY
---

# AgentMail Skill

You can send and receive emails using AgentMail via the REST API. Use the `exec` tool to run curl commands against the API.

## API Base URL

```
https://api.agentmail.to/v0
```

## Authentication header

```
Authorization: Bearer $AGENTMAIL_API_KEY
```

## Common Operations

### List inboxes

```bash
curl -s -H "Authorization: Bearer $AGENTMAIL_API_KEY" \
  https://api.agentmail.to/v0/inboxes
```

### Create an inbox

```bash
curl -s -X POST -H "Authorization: Bearer $AGENTMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"display_name": "My Agent"}' \
  https://api.agentmail.to/v0/inboxes
```

### Send an email

```bash
curl -s -X POST -H "Authorization: Bearer $AGENTMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": ["recipient@example.com"],
    "subject": "Hello from OpenClaw",
    "text": "This email was sent by my AI assistant.",
    "html": "<p>This email was sent by my AI assistant.</p>",
    "attachments": [{
      "filename": "file.ext",
      "content": "$(base64 -w 0 file.ext)",
      "content_type": "The exact MIME type"
    }]
  }' \
  https://api.agentmail.to/v0/inboxes/{inbox_id}/messages/send
```

### List messages in an inbox

```bash
curl -s -H "Authorization: Bearer $AGENTMAIL_API_KEY" \
  https://api.agentmail.to/v0/inboxes/{inbox_id}/messages
```

### Mark message as read

```bash
curl -s -X PATCH -H "Authorization: Bearer $AGENTMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"remove_labels": ["unread"]}' \
  https://api.agentmail.to/v0/inboxes/{inbox_id}/messages/{message_id}
```

### Reply to a message

```bash
curl -s -X POST -H "Authorization: Bearer $AGENTMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "Thanks for your email!"}' \
  https://api.agentmail.to/v0/inboxes/{inbox_id}/messages/{message_id}/reply
```

Note: Replace {message_id} with the URL-encoded message ID
