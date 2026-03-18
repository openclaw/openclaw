---
name: blink-zoom
description: >
  Manage Zoom meetings, webinars, and recordings. Use when asked to create
  meetings, list upcoming calls, get recording links, or check meeting
  participants. Requires a linked Zoom connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "zoom" } }
---

# Blink Zoom

Access the user's linked Zoom account. Provider key: `zoom`.

## List upcoming meetings
```bash
bash scripts/call.sh zoom /users/me/meetings GET '{"type":"upcoming","page_size":20}'
```

## Create a meeting
```bash
bash scripts/call.sh zoom /users/me/meetings POST '{
  "topic": "Team sync",
  "type": 2,
  "start_time": "2024-03-01T10:00:00Z",
  "duration": 60,
  "timezone": "UTC"
}'
```

## Get meeting details
```bash
bash scripts/call.sh zoom /meetings/{meetingId} GET
```

## Delete a meeting
```bash
bash scripts/call.sh zoom /meetings/{meetingId} DELETE
```

## List cloud recordings
```bash
bash scripts/call.sh zoom /users/me/recordings GET '{"page_size":10}'
```

## Get recording for a meeting
```bash
bash scripts/call.sh zoom /meetings/{meetingId}/recordings GET
```

## List webinars
```bash
bash scripts/call.sh zoom /users/me/webinars GET '{"page_size":10}'
```

## Get meeting participants
```bash
bash scripts/call.sh zoom /past_meetings/{meetingId}/participants GET
```

## Common use cases
- "Schedule a Zoom meeting for tomorrow at 2pm" → POST /users/me/meetings
- "List my upcoming Zoom calls" → GET /users/me/meetings?type=upcoming
- "Get the recording link for yesterday's meeting" → GET /users/me/recordings
- "Cancel meeting {id}" → DELETE /meetings/{id}
- "Who attended the last meeting?" → GET /past_meetings/{id}/participants
