# Granola MCP Routing Reference

**App name:** `granola`
**Base URL proxied:** `mcp.granola.ai`

## Connection Management

Manage MCP connections at `https://ctrl.maton.ai`.

### List Connections

```bash
GET https://ctrl.maton.ai/connections?app=granola&method=MCP&status=ACTIVE
Authorization: Bearer $MATON_API_KEY
```

### Create Connection

```bash
POST https://ctrl.maton.ai/connections
Content-Type: application/json
Authorization: Bearer $MATON_API_KEY

{
  "app": "granola",
  "method": "MCP"
}
```

## API Path Pattern

```
/granola/{tool-name}
```

## MCP Reference

All MCP tools use `POST` method:

| Tool                     | Description                                     | Schema                                        |
| ------------------------ | ----------------------------------------------- | --------------------------------------------- |
| `query_granola_meetings` | Chat with meeting notes using natural language  | [schema](schemas/query_granola_meetings.json) |
| `list_meetings`          | List meetings with metadata and attendees       | [schema](schemas/list_meetings.json)          |
| `get_meetings`           | Retrieve detailed content for specific meetings | [schema](schemas/get_meetings.json)           |
| `get_meeting_transcript` | Get raw transcript (paid tiers only)            | [schema](schemas/get_meeting_transcript.json) |

## Common Endpoints

### Query Meetings

Chat with your meeting notes using natural language queries:

```bash
POST /granola/query_granola_meetings
Content-Type: application/json

{
  "query": "What action items came from my meetings this week?"
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "You had 2 recent meetings:\n**Feb 4, 2026 at 7:30 PM** - \"Team sync\" [[0]](https://notes.granola.ai/d/abc123)\n- Action item: Review Q1 roadmap\n- Action item: Schedule follow-up with engineering\n**Jan 27, 2026 at 1:04 AM** - \"Finance integration\" [[1]](https://notes.granola.ai/d/def456)\n- Discussed workflow automation platforms\n- Action item: Evaluate n8n vs Zapier"
    }
  ],
  "isError": false
}
```

**Use cases:**

- "What action items were assigned to me?"
- "Summarize my meetings from last week"
- "What did we discuss about the product launch?"
- "Find all mentions of budget in my meetings"

### List Meetings

List your meetings with metadata including IDs, titles, dates, and attendees:

```bash
POST /granola/list_meetings
Content-Type: application/json

{}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "<meetings_data from=\"Jan 27, 2026\" to=\"Feb 4, 2026\" count=\"2\">\n<meeting id=\"0dba4400-50f1-4262-9ac7-89cd27b79371\" title=\"Team sync\" date=\"Feb 4, 2026 7:30 PM\">\n    <known_participants>\n    John Doe (note creator) from Acme <john@acme.com>\n    Jane Smith from Acme <jane@acme.com>\n    </known_participants>\n  </meeting>\n\n<meeting id=\"4ebc086f-ba8d-49e8-8cd1-ed81ac8f2e3b\" title=\"Finance integration\" date=\"Jan 27, 2026 1:04 AM\">\n    <known_participants>\n    John Doe (note creator) from Acme <john@acme.com>\n    </known_participants>\n  </meeting>\n</meetings_data>"
    }
  ],
  "isError": false
}
```

**Response fields in XML format:**

- `meetings_data`: Container with `from`, `to` date range and `count`
- `meeting`: Individual meeting with `id`, `title`, and `date` attributes
- `known_participants`: List of attendees with name, role, company, and email

### Get Meetings

Retrieve detailed content for specific meetings by ID:

```bash
POST /granola/get_meetings
Content-Type: application/json

{
  "meeting_ids": ["0dba4400-50f1-4262-9ac7-89cd27b79371"]
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "<meetings_data from=\"Feb 4, 2026\" to=\"Feb 4, 2026\" count=\"1\">\n<meeting id=\"0dba4400-50f1-4262-9ac7-89cd27b79371\" title=\"Team sync\" date=\"Feb 4, 2026 7:30 PM\">\n  <known_participants>\n  John Doe (note creator) from Acme <john@acme.com>\n  </known_participants>\n  \n  <summary>\n## Key Decisions\n- Approved Q1 roadmap\n- Budget increased by 15%\n\n## Action Items\n- @john: Review design specs by Friday\n- @jane: Schedule engineering sync\n</summary>\n</meeting>\n</meetings_data>"
    }
  ],
  "isError": false
}
```

**Response includes:**

- Meeting metadata (id, title, date, participants)
- `summary`: AI-generated meeting summary with key decisions and action items
- Enhanced notes and private notes (when available)

### Get Meeting Transcript

Retrieve the raw transcript for a specific meeting (paid tiers only):

```bash
POST /granola/get_meeting_transcript
Content-Type: application/json

{
  "meeting_id": "0dba4400-50f1-4262-9ac7-89cd27b79371"
}
```

**Response (paid tier):**

```json
{
  "content": [
    {
      "type": "text",
      "text": "<transcript meeting_id=\"0dba4400-50f1-4262-9ac7-89cd27b79371\">\n[00:00:15] John: Let's get started with the Q1 planning...\n[00:01:23] Jane: I've prepared the budget breakdown...\n[00:03:45] John: That looks good. What about the timeline?\n</transcript>"
    }
  ],
  "isError": false
}
```

**Response (free tier):**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Transcripts are only available to paid Granola tiers"
    }
  ],
  "isError": true
}
```

## Notes

- All IDs are UUIDs (with or without hyphens)
- Users can only query their own meeting notes; shared notes from others are not accessible
- Basic (free) plan users are limited to notes from the last 30 days
- The `get_meeting_transcript` tool is only available on paid Granola tiers
- If multiple Granola connections exist, specify which to use with `Maton-Connection` header
- Session can be reused by passing the `Mcp-Session-Id` header from previous responses
- Rate limit: ~100 requests/minute

## Resources

- [Granola MCP Documentation](https://docs.granola.ai/help-center/sharing/integrations/mcp)
- [Granola Help Center](https://docs.granola.ai)
- [Maton Community](https://discord.com/invite/dBfFAcefs2)
- [Maton Support](mailto:support@maton.ai)
