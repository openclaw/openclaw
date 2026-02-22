# LangGraph Pre-Response Hook Plugin

Automatically enrich OpenClaw agent context before every response using LangGraph-powered intelligent tool routing.

## Overview

This plugin uses the `before_agent_start` hook to run a LangGraph planner that:

1. **Analyzes user intent** - Detects what type of query this is (task, financial, health, project, etc.)
2. **Routes to relevant tools** - Only runs the tools needed for this specific query
3. **Gathers context in parallel** - Executes tools concurrently for speed
4. **Injects context** - Prepends relevant context to the user's message

The result: Your agent automatically has access to relevant information without manually checking multiple sources.

## Installation

### 1. Install the plugin

```bash
# Via OpenClaw CLI
openclaw plugin install langgraph-pre-response

# Or add to your config
openclaw config set plugins '["langgraph-pre-response"]'
```

### 2. Set up the planner script

Copy the example planner to your workspace:

```bash
cp ~/.openclaw/extensions/langgraph-pre-response/example-planner.py \
   ~/.openclaw/workspace/scripts/langgraph_planner_v4.py
```

Or use your own LangGraph planner that:
- Accepts a query string as first argument
- Outputs JSON to `/tmp/pre_response_results_v4.json`
- Returns within 5 seconds

### 3. Install Python dependencies

```bash
pip install langgraph boto3
```

## Configuration

Add to your `~/.openclaw/config.yaml`:

```yaml
plugins:
  langgraph-pre-response:
    enabled: true
    plannerPath: scripts/langgraph_planner_v4.py
    timeoutMs: 5000
    minPromptLength: 3
    pythonPath: python3
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the hook |
| `plannerPath` | string | `scripts/langgraph_planner_v4.py` | Path to planner script (relative to workspace or absolute) |
| `timeoutMs` | number | `5000` | Maximum execution time in ms |
| `minPromptLength` | number | `3` | Minimum prompt length to trigger planner |
| `resultsPath` | string | `/tmp/pre_response_results_v4.json` | Where to write results JSON |
| `pythonPath` | string | `python3` | Python executable |
| `env` | object | `{}` | Additional environment variables |

## How It Works

### Hook Lifecycle

```
User Message
    │
    ▼
┌─────────────────────────────────────┐
│     before_agent_start hook         │
│                                     │
│  1. Parse user intent (via AI)      │
│  2. Route to relevant tools         │
│  3. Execute tools in parallel       │
│  4. Format context                  │
│  5. Return { prependContext: ... }  │
└─────────────────────────────────────┘
    │
    ▼
[Context prepended to prompt]
    │
    ▼
LLM generates response
```

### Intent → Tool Routing

The planner uses AI (Claude Haiku, ~$0.0001/query) to detect intents:

| Intent | Example Query | Tools Run |
|--------|---------------|-----------|
| `task_query` | "What should I do today?" | commitments, todo, calendar |
| `urgent_check` | "Anything I need to know?" | commitments, todo, calendar, gmail |
| `financial_query` | "How much did I spend?" | beancount |
| `health_query` | "What's my weight?" | health data |
| `project_query` | "Status on Prince?" | knowledge graphs, project files |
| `past_discussion` | "What did we discuss?" | QMD search, memory |
| `external_info` | "Who won the Super Bowl?" | web search |

### Performance

- **Typical latency**: 0.5-2s depending on tools needed
- **Parallel execution**: All selected tools run concurrently
- **Timeout protection**: Falls back gracefully if exceeded
- **Cost**: ~$0.0001 per query for intent detection

## Example Output

When you ask "What should I do today?", the plugin injects context like:

```markdown
## Pre-Response Context (Auto-Generated)
_Intents detected: task_query_

### Commitments
**Overdue:**
- ⚠️ Review PR for project X (due 2026-02-14)

**Upcoming:**
- Submit tax documents (due 2026-02-20)
- Team standup (due 2026-02-16)

### TODO Items
**Critical:**
- 🚨 Fix production bug (CRITICAL)
- 🚨 Call accountant (deadline: today)

Open items: CRITICAL: 2, Today: 5, This Week: 12

### Calendar
- 10:00 AM: Team standup
- 2:00 PM: Client call
- 6:00 PM: Dinner reservation at Osteria

---

[User's original message follows]
```

## Writing a Custom Planner

Your planner script must:

1. Accept the query as the first CLI argument
2. Output a JSON file to the configured `resultsPath`
3. Complete within `timeoutMs`

### Expected JSON Schema

```json
{
  "query": "What should I do today?",
  "intents": ["task_query"],
  "entities": {
    "date": { "relative": "today", "absolute": "2026-02-15" }
  },
  "tools_executed": ["commitments_check", "todo_parse", "calendar_check"],
  "results": {
    "commitments_check": {
      "overdue": [...],
      "upcoming": [...],
      "summary": "1 overdue, 3 upcoming"
    },
    "todo_parse": {
      "critical_items": [...],
      "open_by_section": { ... },
      "summary": "2 critical, 15 total open"
    }
  },
  "summary": "Intents: task_query\nTools: 3",
  "elapsed_seconds": 1.23,
  "timestamp": "2026-02-15T22:31:00Z"
}
```

### Available Tools

The example planner includes these tools:

- `web_search` - External search queries
- `memory_search` - Mem0 memory lookup
- `qmd_search` - QMD session history
- `cursor_history` - Recent Cursor IDE work
- `file_read` - Workspace files
- `file_search` - Find files by name/content
- `knowledge_graph_load` - Entity knowledge bases
- `project_files_read` - Project documentation
- `commitments_check` - Commitment tracking DB
- `todo_parse` - TODO.md parsing
- `beancount_query` - Financial data
- `gmail_search` - Recent emails
- `calendar_check` - Calendar events
- `health_data` - Health metrics
- `cron_jobs` - Scheduled jobs

## Troubleshooting

### Plugin not running

Check if enabled:
```bash
openclaw config get plugins.langgraph-pre-response.enabled
```

### Planner timing out

Increase timeout:
```yaml
plugins:
  langgraph-pre-response:
    timeoutMs: 10000
```

### No context being injected

1. Check planner exists: `ls ~/.openclaw/workspace/scripts/langgraph_planner_v4.py`
2. Test manually: `python3 ~/.openclaw/workspace/scripts/langgraph_planner_v4.py "test query"`
3. Check results: `cat /tmp/pre_response_results_v4.json`

### Debug logging

Enable debug logs:
```bash
OPENCLAW_LOG=debug openclaw gateway start
```

## License

MIT - See LICENSE file in the OpenClaw repository.
