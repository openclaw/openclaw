---
name: chatgpt-exporter-ultimate
description: Export ALL your ChatGPT conversations instantly — no 24h wait, no extensions. Works via browser relay OR standalone bookmarklet. Extracts full message history with timestamps, roles, and metadata. One command, one JSON file, done.
---

# ChatGPT Exporter ULTIMATE

> 🔗 **Part of the OpenClaw Ecosystem** — This skill is part of a larger AI agent revamp project.
> Full project: https://github.com/openclaw/openclaw

Export all ChatGPT conversations in seconds — no waiting for OpenAI's 24-hour export email.

## Usage

```
Export my ChatGPT conversations
```

## Requirements

1. User must attach their Chrome ChatGPT tab via browser relay
2. User must be logged into ChatGPT

## How It Works

1. **Attach browser** - User clicks OpenClaw toolbar icon on chatgpt.com tab
2. **Inject script** - Agent injects background export script
3. **Fetch all** - Script fetches all conversations via internal API
4. **Download** - JSON file auto-downloads to user's Downloads folder

## Technical Details

### Authentication
ChatGPT's internal API requires a Bearer token from `/api/auth/session`:
```javascript
const session = await fetch('/api/auth/session', { credentials: 'include' });
const { accessToken } = await session.json();
```

### API Endpoints
| Endpoint | Purpose |
|----------|---------|
| `/api/auth/session` | Get access token |
| `/backend-api/conversations?offset=N&limit=100` | List conversations |
| `/backend-api/conversation/{id}` | Get full conversation |

### Export Script
The agent injects a self-running script that:
1. Fetches the access token
2. Paginates through all conversations (100 per page)
3. Fetches each conversation's full content
4. Extracts messages from the mapping tree
5. Creates JSON blob and triggers download

### Progress Tracking
```javascript
window.__exportStatus = { phase: 'fetching', progress: N, total: M }
```

## Output Format

```json
{
  "exported": "2026-02-06T11:10:09.699Z",
  "conversations": [
    {
      "id": "abc123",
      "title": "Conversation Title",
      "created": 1770273234.966738,
      "messages": [
        { "role": "user", "text": "...", "time": 1770273234 },
        { "role": "assistant", "text": "...", "time": 1770273240 }
      ]
    }
  ]
}
```

## Rate Limits

- 100ms delay between conversation fetches
- ~3 minutes for 200 conversations
- ChatGPT allows ~100 requests/minute

## Troubleshooting

| Issue | Solution |
|-------|----------|
| No tab attached | Click OpenClaw toolbar icon on ChatGPT tab |
| 401 error | Log into ChatGPT and re-attach tab |
| Export stuck | Check browser console for errors |
| No download | Check Downloads folder / browser settings |

## Files

- `scripts/bookmarklet.js` - Standalone console script (paste in DevTools)
- `scripts/export.sh` - CLI export with token argument

## Comparison to Extensions

| Feature | This Skill | ChatGPT Exporter Extension |
|---------|------------|---------------------------|
| Installation | None | Chrome Web Store |
| Automation | Full (agent-controlled) | Manual (user clicks) |
| Format | JSON | JSON, MD, HTML, PNG |
| Batch export | ✅ Auto | ✅ "Select All" |
| Progress | Agent monitors | UI progress bar |

**When to use this skill:** Automated exports, programmatic access, agent workflows
**When to use extension:** Manual exports, multiple formats, visual UI
