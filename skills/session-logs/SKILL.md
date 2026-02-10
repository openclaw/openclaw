---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: session-logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Search and analyze your own session logs (older/parent conversations) using jq.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata: { "openclaw": { "emoji": "📜", "requires": { "bins": ["jq", "rg"] } } }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# session-logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Search your complete conversation history stored in session JSONL files. Use this when a user references older/parent conversations or asks what was said before.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Trigger（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use this skill when the user asks about prior chats, parent conversations, or historical context that isn't in memory files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Location（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Session logs live at: `~/.openclaw/agents/<agentId>/sessions/` (use the `agent=<id>` value from the system prompt Runtime line).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`sessions.json`** - Index mapping session keys to session IDs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`<session-id>.jsonl`** - Full conversation transcript per session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Structure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each `.jsonl` file contains messages with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `type`: "session" (metadata) or "message"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timestamp`: ISO timestamp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message.role`: "user", "assistant", or "toolResult"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message.content[]`: Text, thinking, or tool calls (filter `type=="text"` for human-readable content)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message.usage.cost.total`: Cost per response（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common Queries（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### List all sessions by date and size（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for f in ~/.openclaw/agents/<agentId>/sessions/*.jsonl; do（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  date=$(head -1 "$f" | jq -r '.timestamp' | cut -dT -f1)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  size=$(ls -lh "$f" | awk '{print $5}')（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  echo "$date $size $(basename $f)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
done | sort -r（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Find sessions from a specific day（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for f in ~/.openclaw/agents/<agentId>/sessions/*.jsonl; do（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  head -1 "$f" | jq -r '.timestamp' | grep -q "2026-01-06" && echo "$f"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
done（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Extract user messages from a session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
jq -r 'select(.message.role == "user") | .message.content[]? | select(.type == "text") | .text' <session>.jsonl（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Search for keyword in assistant responses（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
jq -r 'select(.message.role == "assistant") | .message.content[]? | select(.type == "text") | .text' <session>.jsonl | rg -i "keyword"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Get total cost for a session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
jq -s '[.[] | .message.usage.cost.total // 0] | add' <session>.jsonl（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Daily cost summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for f in ~/.openclaw/agents/<agentId>/sessions/*.jsonl; do（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  date=$(head -1 "$f" | jq -r '.timestamp' | cut -dT -f1)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  cost=$(jq -s '[.[] | .message.usage.cost.total // 0] | add' "$f")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  echo "$date $cost"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
done | awk '{a[$1]+=$2} END {for(d in a) print d, "$"a[d]}' | sort -r（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Count messages and tokens in a session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
jq -s '{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  messages: length,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  user: [.[] | select(.message.role == "user")] | length,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  assistant: [.[] | select(.message.role == "assistant")] | length,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  first: .[0].timestamp,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  last: .[-1].timestamp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}' <session>.jsonl（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tool usage breakdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
jq -r '.message.content[]? | select(.type == "toolCall") | .name' <session>.jsonl | sort | uniq -c | sort -rn（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Search across ALL sessions for a phrase（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
rg -l "phrase" ~/.openclaw/agents/<agentId>/sessions/*.jsonl（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tips（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions are append-only JSONL (one JSON object per line)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Large sessions can be several MB - use `head`/`tail` for sampling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The `sessions.json` index maps chat providers (discord, whatsapp, etc.) to session IDs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Deleted sessions have `.deleted.<timestamp>` suffix（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Fast text-only hint (low noise)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
jq -r 'select(.type=="message") | .message.content[]? | select(.type=="text") | .text' ~/.openclaw/agents/<agentId>/sessions/<id>.jsonl | rg 'keyword'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
