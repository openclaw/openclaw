---
name: session-logs
description: Search and analyze your own SQLite-backed session logs (older/parent conversations).
metadata:
  {
    "openclaw":
      {
        "emoji": "📜",
        "requires": { "bins": ["jq", "rg", "sqlite3"] },
        "install":
          [
            {
              "id": "brew-jq",
              "kind": "brew",
              "formula": "jq",
              "bins": ["jq"],
              "label": "Install jq (brew)",
            },
            {
              "id": "brew-rg",
              "kind": "brew",
              "formula": "ripgrep",
              "bins": ["rg"],
              "label": "Install ripgrep (brew)",
            },
            {
              "id": "brew-sqlite",
              "kind": "brew",
              "formula": "sqlite",
              "bins": ["sqlite3"],
              "label": "Install sqlite3 (brew)",
            },
          ],
      },
  }
---

# session-logs

Search your complete conversation history stored in per-agent SQLite databases.
Use this when a user references older/parent conversations or asks what was said
before.

## Trigger

Use this skill when the user asks about prior chats, parent conversations, or historical context that isn't in memory files.

## Location

Session logs live under the active state directory in the per-agent database:
`$OPENCLAW_STATE_DIR/agents/<agentId>/agent/openclaw-agent.sqlite` (default:
`~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`).
Use the `agent=<id>` value from the system prompt Runtime line.

- **`session_entries`** - Session-key rows with JSON metadata
- **`transcript_events`** - Full conversation transcript event stream per session
- **`transcript_event_identities`** - Queryable event ids, parent ids, event types, and idempotency keys

Legacy JSON/JSONL files under `agents/<agentId>/sessions/` are doctor migration
inputs or explicit debug/export artifacts only.

## Structure

Each `transcript_events.event_json` value uses the same JSON shape exported to
JSONL:

- `type`: "session" (metadata) or "message"
- `timestamp`: ISO timestamp
- `message.role`: "user", "assistant", or "toolResult"
- `message.content[]`: Text, thinking, or tool calls (filter `type=="text"` for human-readable content)
- `message.usage.cost.total`: Cost per response

## Common Queries

### List all sessions by date and size

```bash
AGENT_ID="<agentId>"
DB="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/agents/$AGENT_ID/agent/openclaw-agent.sqlite"
sqlite3 -readonly -json "$DB" '
  SELECT
    session_key,
    json_extract(entry_json, "$.sessionId") AS session_id,
    updated_at
  FROM session_entries
  ORDER BY updated_at DESC
  LIMIT 100;
' | jq -r '.[] | "\(.updated_at) \(.session_id) \(.session_key)"'
```

### Find sessions from a specific day

```bash
AGENT_ID="<agentId>"
DB="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/agents/$AGENT_ID/agent/openclaw-agent.sqlite"
sqlite3 -readonly -json "$DB" '
  SELECT session_id, min(created_at) AS first_event_at, max(created_at) AS last_event_at
  FROM transcript_events
  GROUP BY session_id
  HAVING date(first_event_at / 1000, "unixepoch") = "2026-01-06"
  ORDER BY first_event_at DESC;
'
```

### Extract user messages from a session

```bash
AGENT_ID="<agentId>"
SESSION_ID="<sessionId>"
DB="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/agents/$AGENT_ID/agent/openclaw-agent.sqlite"
sqlite3 -readonly -noheader "$DB" \
  "SELECT event_json FROM transcript_events WHERE session_id = '$SESSION_ID' ORDER BY seq;" |
  jq -r 'select(.message.role == "user") | .message.content[]? | select(.type == "text") | .text'
```

### Search for keyword in assistant responses

```bash
AGENT_ID="<agentId>"
SESSION_ID="<sessionId>"
DB="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/agents/$AGENT_ID/agent/openclaw-agent.sqlite"
sqlite3 -readonly -noheader "$DB" \
  "SELECT event_json FROM transcript_events WHERE session_id = '$SESSION_ID' ORDER BY seq;" |
  jq -r 'select(.message.role == "assistant") | .message.content[]? | select(.type == "text") | .text' |
  rg -i "keyword"
```

### Get total cost for a session

```bash
AGENT_ID="<agentId>"
SESSION_ID="<sessionId>"
DB="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/agents/$AGENT_ID/agent/openclaw-agent.sqlite"
sqlite3 -readonly -noheader "$DB" \
  "SELECT event_json FROM transcript_events WHERE session_id = '$SESSION_ID' ORDER BY seq;" |
  jq -s '[.[] | .message.usage.cost.total // 0] | add'
```

### Daily cost summary

```bash
AGENT_ID="<agentId>"
DB="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/agents/$AGENT_ID/agent/openclaw-agent.sqlite"
sqlite3 -readonly -noheader "$DB" 'SELECT event_json FROM transcript_events ORDER BY created_at;' |
  jq -r '[.timestamp[0:10], (.message.usage.cost.total // 0)] | @tsv' |
  awk '{a[$1]+=$2} END {for(d in a) print d, "$"a[d]}' | sort -r
```

### Count messages and tokens in a session

```bash
AGENT_ID="<agentId>"
SESSION_ID="<sessionId>"
DB="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/agents/$AGENT_ID/agent/openclaw-agent.sqlite"
sqlite3 -readonly -noheader "$DB" \
  "SELECT event_json FROM transcript_events WHERE session_id = '$SESSION_ID' ORDER BY seq;" |
  jq -s '{
  messages: length,
  user: [.[] | select(.message.role == "user")] | length,
  assistant: [.[] | select(.message.role == "assistant")] | length,
  first: .[0].timestamp,
  last: .[-1].timestamp
}'
```

### Tool usage breakdown

```bash
AGENT_ID="<agentId>"
SESSION_ID="<sessionId>"
DB="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/agents/$AGENT_ID/agent/openclaw-agent.sqlite"
sqlite3 -readonly -noheader "$DB" \
  "SELECT event_json FROM transcript_events WHERE session_id = '$SESSION_ID' ORDER BY seq;" |
  jq -r '.message.content[]? | select(.type == "toolCall") | .name' |
  sort | uniq -c | sort -rn
```

### Search across ALL sessions for a phrase

```bash
AGENT_ID="<agentId>"
DB="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/agents/$AGENT_ID/agent/openclaw-agent.sqlite"
sqlite3 -readonly -noheader "$DB" 'SELECT session_id || char(9) || event_json FROM transcript_events ORDER BY created_at;' |
  rg -i "phrase"
```

## Tips

- Sessions are append-only SQLite rows; export/debug JSONL is one JSON object per line
- Large sessions can be several MB; always filter by `session_id` when you know it
- `session_entries` maps chat providers (Discord, WhatsApp, etc.) to session IDs
- Deleted legacy debug/export files can have `.deleted.<timestamp>` suffix

## Fast text-only hint (low noise)

```bash
AGENT_ID="<agentId>"
SESSION_ID="<sessionId>"
DB="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/agents/$AGENT_ID/agent/openclaw-agent.sqlite"
sqlite3 -readonly -noheader "$DB" \
  "SELECT event_json FROM transcript_events WHERE session_id = '$SESSION_ID' ORDER BY seq;" |
  jq -r 'select(.type=="message") | .message.content[]? | select(.type=="text") | .text' |
  rg 'keyword'
```
