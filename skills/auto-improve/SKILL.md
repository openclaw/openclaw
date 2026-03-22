---
name: auto-improve
description: Evaluation harness for the auto-improve agent. Contains JSONL log parsing schema, metric computation formulas, scoring thresholds, and file access rules. Read-only — do not modify.
metadata:
  openclaw:
    emoji: "🔬"
---

# Auto-Improve Evaluation Harness

This skill defines the fixed evaluation rules for the auto-improve agent. Like `prepare.py` in AutoResearch, this file is NOT modified by the agent.

## JSONL Session Log Schema

Session files are at `~/.openclaw/agents/main/sessions/*.jsonl`. Each line is a JSON object.

### Entry Types

```
type: "session"     — Header with session ID, version, timestamp, cwd
type: "message"     — User or assistant message
type: "model_change" — Model switch
type: "thinking_level_change" — Thinking level change
type: "custom"      — Custom events (model snapshots, etc.)
```

### Message Structure

```json
{
  "type": "message",
  "id": "abc123",
  "timestamp": "2026-03-22T...",
  "message": {
    "role": "user" | "assistant",
    "content": [
      { "type": "text", "text": "..." },
      { "type": "thinking", "text": "..." },
      { "type": "toolCall", "id": "...", "name": "tool_name", "arguments": {...} },
      { "type": "toolResult", "id": "...", "content": "...", "is_error": true|false }
    ]
  }
}
```

### Extracting Tool Calls

Tool calls have `type: "toolCall"` in the content array. Key fields:

- `name` — the tool name (e.g., "exec", "memory_search", "sessions_spawn")
- `arguments` — the tool arguments as an object

Tool results have `type: "toolResult"` with `is_error: true|false`.

### Extracting User Messages

User messages have `message.role === "user"`. The text content is in content items with `type: "text"`.

### Extracting Assistant Responses

Assistant messages have `message.role === "assistant"`. Text content is in items with `type: "text"`.

## Metric Formulas

### 1. Delegation Ratio (weight: 0.30)

```
direct_tools = count of toolCalls where name in ["exec", "mcp_search", "web_search", "web_fetch"]
delegation_tools = count of toolCalls where name in ["sessions_spawn", "message"]
total = direct_tools + delegation_tools

delegation_ratio = delegation_tools / max(total, 1)
```

Score: `delegation_ratio` (0.0 to 1.0, higher is better)

If `total === 0` (no tool calls at all), score is 0.5 (neutral).

### 2. Memory Usage Rate (weight: 0.20)

```
context_trigger_pattern = /\b(remember|last time|before|earlier|yesterday|previous|we discussed|you said|I told you|what was|did we|pending|todo|remind me|what happened)\b/i

context_messages = count of user messages matching context_trigger_pattern
memory_searches = count of toolCalls where name === "memory_search"

memory_rate = memory_searches / max(context_messages, 1)
```

Score: `min(memory_rate, 1.0)` (capped at 1.0, higher is better)

If `context_messages === 0`, score is 1.0 (no context questions = nothing to search).

### 3. Conciseness (weight: 0.15)

```
For each assistant text response:
  word_count = response.split(/\s+/).length

avg_words = mean of all response word counts
```

Score mapping:

- 0-50 words average: 1.0
- 50-100 words average: 0.8
- 100-150 words average: 0.6
- 150-200 words average: 0.4
- 200+ words average: 0.2

Exclude responses that are clearly multi-part (contain tables, code blocks, or lists >5 items) — these are expected to be longer.

### 4. Silent Reply Accuracy (weight: 0.15)

```
off_channel_messages = count of user messages from a different channel/topic than the session header
correct_silent = count of assistant responses that are exactly "NO_REPLY" following an off-channel message
incorrect_responses = off_channel_messages - correct_silent

silent_accuracy = correct_silent / max(off_channel_messages, 1)
```

Score: `silent_accuracy` (0.0 to 1.0, higher is better)

If `off_channel_messages === 0`, score is 1.0 (no off-channel messages = nothing to be silent about).

### 5. Tool Error Rate (weight: 0.20)

```
total_tool_calls = count of all toolCalls
error_results = count of toolResults where is_error === true

error_rate = error_results / max(total_tool_calls, 1)
```

Score: `1.0 - error_rate` (inverted, higher is better)

If `total_tool_calls === 0`, score is 1.0.

## Composite Score

```
composite = (delegation * 0.30) + (memory * 0.20) + (conciseness * 0.15) + (silent_reply * 0.15) + (error_rate_score * 0.20)
```

Range: 0.0 to 1.0. Higher is better.

## Keep/Discard Thresholds

| Condition                            | Action                                              |
| ------------------------------------ | --------------------------------------------------- |
| `new_score > previous_score + 0.01`  | **Keep** — meaningful improvement                   |
| `new_score >= previous_score - 0.01` | **Keep** — within noise, but simpler code is valued |
| `new_score < previous_score - 0.01`  | **Discard** — regression                            |

The 0.01 margin accounts for natural variance in conversations (different messages produce different tool call patterns).

## Simplicity Criterion

All else being equal, simpler workspace files are better:

- Removing text that doesn't affect the score → keep the removal
- Adding text that doesn't improve the score → discard the addition
- A small score improvement from a large text addition → weigh carefully

## File Access Rules (Enforced)

| File                                             | Permission   |
| ------------------------------------------------ | ------------ |
| `~/.openclaw/workspace/AGENTS.md`                | READ + WRITE |
| `~/.openclaw/workspace/SOUL.md`                  | READ + WRITE |
| `~/.openclaw/workspace/TOOLS.md`                 | READ + WRITE |
| `~/.openclaw/workspace/HEARTBEAT.md`             | READ + WRITE |
| `~/.openclaw/workspace/MEMORY.md`                | READ ONLY    |
| `~/.openclaw/workspace/IDENTITY.md`              | READ ONLY    |
| `~/.openclaw/workspace/auto-improve/results.tsv` | READ + WRITE |
| `~/.openclaw/agents/main/sessions/*.jsonl`       | READ ONLY    |
| Everything else                                  | NO ACCESS    |

## Results Tracking Format

File: `~/.openclaw/workspace/auto-improve/results.tsv`

Header row (tab-separated):

```
commit	score	delegation	memory	conciseness	silent_reply	error_rate	status	description
```

- `commit`: git short SHA (7 chars), or "baseline" for first entry
- `score`: composite score (e.g., 0.650)
- `delegation` through `error_rate`: individual metric scores
- `status`: `baseline`, `keep`, or `discard`
- `description`: short text of what was changed

## Session Selection

When scoring, use the N most recent sessions (default N=5). Skip:

- Sessions shorter than 3 messages (too little data)
- Sessions that are purely heartbeat (only HEARTBEAT_OK responses)
- Sessions from other agents (only use `main` agent sessions)

Sort by modification time, newest first.
