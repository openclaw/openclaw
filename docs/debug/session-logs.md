---
summary: "Search and analyze your session logs (conversation history) using jq and rg"
read_when:
  - You need to find something said in a prior conversation
  - You want to analyze token usage or tool patterns across sessions
  - You are auditing conversation history for cost or content review
title: "Session Logs"
---

# Session Logs

OpenClaw stores complete conversation transcripts as JSONL files per session.
This guide shows how to search and analyze your session logs using `jq` and `rg`
(ripgrep).

## Where session logs live

Session logs are stored per agent under:

`~/.openclaw/agents/<agentId>/sessions/`

Find your agent ID in the system prompt `Runtime` line (e.g., `agent=upstream-docs-scout`).

Directory contents:

- **`sessions.json`** — Index mapping chat providers to session IDs
- **`<session-id>.jsonl`** — Full conversation transcript (one JSON object per line)
- **`*.deleted.<timestamp>`** — Deleted sessions (retained for recovery)

## Session log structure

Each line in a `.jsonl` file is a JSON object with:

- `type`: `"session"` (metadata) or `"message"`
- `timestamp`: ISO-8601 timestamp
- `message.role`: `"user"`, `"assistant"`, or `"toolResult"`
- `message.content[]`: Array of content blocks (text, thinking, tool calls)
- `message.usage.cost.total`: Cost per response (when available)

## Common queries

### List all sessions by date and size

```bash
for f in ~/.openclaw/agents/<agentId>/sessions/*.jsonl; do
  date=$(head -1 "$f" | jq -r '.timestamp' | cut -dT -f1)
  size=$(ls -lh "$f" | awk '{print $5}')
  echo "$date $size $(basename $f)"
done | sort -r
```

### Find sessions from a specific day

```bash
for f in ~/.openclaw/agents/<agentId>/sessions/*.jsonl; do
  head -1 "$f" | jq -r '.timestamp' | grep -q "2026-03-12" && echo "$f"
done
```

### Extract user messages from a session

```bash
jq -r 'select(.message.role == "user") | .message.content[]? | select(.type == "text") | .text' <session>.jsonl
```

### Search for a keyword in assistant responses

```bash
jq -r 'select(.message.role == "assistant") | .message.content[]? | select(.type == "text") | .text' <session>.jsonl | rg -i "keyword"
```

### Get total cost for a session

```bash
jq -s '[.[] | .message.usage.cost.total // 0] | add' <session>.jsonl
```

### Daily cost summary

```bash
for f in ~/.openclaw/agents/<agentId>/sessions/*.jsonl; do
  date=$(head -1 "$f" | jq -r '.timestamp' | cut -dT -f1)
  cost=$(jq -s '[.[] | .message.usage.cost.total // 0] | add' "$f")
  echo "$date $cost"
done | awk '{a[$1]+=$2} END {for(d in a) print d, "$"a[d]}' | sort -r
```

### Count messages and tokens in a session

```bash
jq -s '{
  messages: length,
  user: [.[] | select(.message.role == "user")] | length,
  assistant: [.[] | select(.message.role == "assistant")] | length,
  first: .[0].timestamp,
  last: .[-1].timestamp
}' <session>.jsonl
```

### Tool usage breakdown

```bash
jq -r '.message.content[]? | select(.type == "toolCall") | .name' <session>.jsonl | sort | uniq -c | sort -rn
```

### Search across ALL sessions for a phrase

```bash
rg -l "phrase" ~/.openclaw/agents/<agentId>/sessions/*.jsonl
```

### Fast text-only search (low noise)

```bash
jq -r 'select(.type=="message") | .message.content[]? | select(.type=="text") | .text' ~/.openclaw/agents/<agentId>/sessions/<id>.jsonl | rg 'keyword'
```

## Tips

- Sessions are **append-only** JSONL (one JSON object per line)
- Large sessions can be several MB — use `head`/`tail` for sampling
- The `sessions.json` index maps chat providers (discord, whatsapp, etc.) to session IDs
- Deleted sessions have `.deleted.<timestamp>` suffix and can be recovered
- Use `jq -s` (slurp) to process the entire file as an array

## Related

- [Logging](/logging) — Gateway file logs and console output
- [Tools: sessions](/tools/index#sessions_list--sessions_history--sessions_send--sessions_spawn--session_status) — Agent tools for session management
