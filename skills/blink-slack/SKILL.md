---
name: blink-slack
description: >
  Send messages, read channel history, list channels and users, manage Slack
  workspace. Use when asked to send Slack messages, check conversations, notify
  teammates, or read Slack channels.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "slack" } }
---

# Blink Slack

Post and read messages in the user's linked Slack workspace. Provider key: `slack`.

## List channels
```bash
bash scripts/call.sh slack /conversations.list GET \
  '{"types": "public_channel,private_channel", "limit": 50}'
```

## Send a message to a channel
```bash
bash scripts/call.sh slack /chat.postMessage POST '{
  "channel": "#general",
  "text": "Hello from your Blink Claw agent!"
}'
```

## Send a DM to a user
```bash
bash scripts/call.sh slack /conversations.open POST '{"users": "U12345678"}'
# Then use the returned channel ID:
bash scripts/call.sh slack /chat.postMessage POST '{"channel": "D12345678", "text": "Direct message"}'
```

## Read recent messages from a channel
```bash
bash scripts/call.sh slack /conversations.history GET \
  '{"channel": "C12345678", "limit": 20}'
```

## Get channel info
```bash
bash scripts/call.sh slack /conversations.info GET '{"channel": "C12345678"}'
```

## List users
```bash
bash scripts/call.sh slack /users.list GET '{"limit": 50}'
```

## Search messages
```bash
bash scripts/call.sh slack /search.messages GET '{"query": "project deadline", "count": 10}'
```

## Post with blocks (rich formatting)
```bash
bash scripts/call.sh slack /chat.postMessage POST '{
  "channel": "#general",
  "blocks": [{
    "type": "section",
    "text": {"type": "mrkdwn", "text": "*Summary*\nTask completed successfully."}
  }]
}'
```

## Common use cases
- "Send a message to #engineering: deploy is complete" → postMessage
- "Check what was discussed in #general today" → conversations.history
- "DM Alex about the meeting time change" → open DM + postMessage
- "List all channels in our Slack" → conversations.list
- "Find messages about the Q2 roadmap" → search.messages
- "Notify the team that the build failed" → postMessage to a channel
