---
name: dj-capture
description: Capture a message or voice note as a Notion task or note.
metadata:
  {
    "openclaw":
      {
        "emoji": "📥",
        "requires": { "env": ["NOTION_API_KEY"] },
        "commands": [{ "name": "capture", "description": "Save message as Notion task/note" }],
      },
  }
---

# dj-capture

Turn any message (text or transcribed voice note) into a Notion task or note.

## Usage

```
/capture Buy new headphones before Friday gig
/capture meeting note: Label wants 3 remixes by March
/capture idea: Mashup of that 90s track with current banger
```

## Capture Types

The skill auto-detects type from content or explicit prefix:

- **task** (default): Creates item in Tasks database
- **note**: Creates page in a general Notes database
- **meeting**: Creates entry in Meetings Prep database
- **idea**: Creates entry in Research Radar with "Idea" tag

Prefixes (optional):
- `task:` or `todo:`
- `note:`
- `meeting:` or `mtg:`
- `idea:`

## Implementation

### Parse Input

Extract type prefix if present, otherwise default to task:

```
Input: "meeting note: Label wants 3 remixes by March"
→ Type: meeting
→ Content: "Label wants 3 remixes by March"
```

### Create Notion Entry

**For Tasks:**

```bash
NOTION_KEY=$(cat ~/.config/notion/api_key)
TASKS_DB_ID="${DJ_NOTION_TASKS_DB}"

curl -X POST "https://api.notion.com/v1/pages" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2025-09-03" \
  -H "Content-Type: application/json" \
  -d '{
    "parent": {"database_id": "'"$TASKS_DB_ID"'"},
    "properties": {
      "Name": {"title": [{"text": {"content": "'"$TASK_TITLE"'"}}]},
      "Status": {"select": {"name": "Inbox"}},
      "Source": {"select": {"name": "Voice Capture"}}
    }
  }'
```

**For Meeting Notes:**

```bash
MEETINGS_DB_ID="${DJ_NOTION_MEETINGS_DB}"

curl -X POST "https://api.notion.com/v1/pages" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2025-09-03" \
  -H "Content-Type: application/json" \
  -d '{
    "parent": {"database_id": "'"$MEETINGS_DB_ID"'"},
    "properties": {
      "Name": {"title": [{"text": {"content": "'"$MEETING_TITLE"'"}}]},
      "Date": {"date": {"start": "'"$(date -u +%Y-%m-%d)"'"}}
    },
    "children": [
      {"object": "block", "type": "paragraph", "paragraph": {"rich_text": [{"text": {"content": "'"$CONTENT"'"}}]}}
    ]
  }'
```

## Date Parsing

If the capture contains date references, extract and set Due date:

- "by Friday" → Due: next Friday
- "tomorrow" → Due: tomorrow
- "next week" → Due: +7 days
- "March 15" → Due: 2026-03-15

## Voice Note Handling

When a voice note is attached:
1. Transcribe using OpenAI Whisper (via skill) or built-in transcription
2. Use transcription as capture content
3. Optionally attach original audio file to Notion page

## Response

Confirm capture with link:

```
📥 Captured as task: "Buy new headphones before Friday gig"
Due: Fri Feb 6
→ [Open in Notion](https://notion.so/...)
```

## Configuration

- `DJ_NOTION_TASKS_DB`: Tasks database ID
- `DJ_NOTION_MEETINGS_DB`: Meetings Prep database ID
- `DJ_NOTION_NOTES_DB`: General notes database ID
- `DJ_NOTION_RESEARCH_DB`: Research Radar database ID

## WorkSafe Mode

In WorkSafe mode, captures go to a separate work-only database:
- `DJ_NOTION_WORK_NOTES_DB`: Work notes database ID
- No access to personal databases
- Generic note format only (no task/meeting/idea types)
