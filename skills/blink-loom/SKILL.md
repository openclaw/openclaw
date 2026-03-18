---
name: blink-loom
description: >
  Access Loom recordings and workspaces. Use when asked to list recordings, get
  video links, share Loom videos, or access Loom content. Requires a linked
  Loom connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "loom" } }
---

# Blink Loom

Access the user's linked Loom account. Provider key: `loom`.

## List recordings
```bash
bash scripts/call.sh loom /recordings GET '{"limit":20}'
```

## Get a recording
```bash
bash scripts/call.sh loom /recordings/{id} GET
```

## Get recording transcription
```bash
bash scripts/call.sh loom /recordings/{id}/transcription GET
```

## List workspaces
```bash
bash scripts/call.sh loom /workspaces GET
```

## Get workspace folders
```bash
bash scripts/call.sh loom /workspaces/{workspace_id}/folders GET
```

## Search recordings
```bash
bash scripts/call.sh loom /recordings GET '{"search":"onboarding","limit":10}'
```

## Common use cases
- "List my recent Loom recordings" → GET /recordings
- "Get the link to my onboarding video" → GET /recordings?search=onboarding
- "What's the transcript for recording X?" → GET /recordings/{id}/transcription
- "Show all Loom recordings from this week" → GET /recordings with date filters
- "Find my product demo Loom" → GET /recordings?search=demo
