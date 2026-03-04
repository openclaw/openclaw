# Usage Tracker

OpenClaw plugin that tracks tool calls and skill usage in real-time, with
historical backfill from session transcripts.

## Features

- **Real-time tracking** via `after_tool_call` hook — every tool invocation is recorded
- **Skill classification** — detects when the agent reads a SKILL.md (entry) or supporting files (sub)
- **Skill session lifecycle** — measures the full chain from SKILL.md read to final response
- **Historical backfill** — scans session transcript JSONL files to reconstruct past data
- **Query engine** — aggregate by tool, skill, day, or agent with date range filters
- **Agent tool** — `usage_tracker` tool for in-conversation queries
- **Web dashboard** — Chart.js-powered dark-theme dashboard at `/plugins/usage-tracker/`
- **Zero external dependencies** — uses only Node.js built-ins; Chart.js loaded via CDN

## Usage

### Enable the plugin

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "usage-tracker": {
        "enabled": true
      }
    }
  }
}
```

### Agent tool

The plugin registers a `usage_tracker` tool with these actions:

| Action           | Description                                                        |
| ---------------- | ------------------------------------------------------------------ |
| `status`         | Overview: total records, date range, top tools/skills              |
| `query`          | Aggregated tool/skill usage with groupBy (tool, skill, day, agent) |
| `skill_health`   | Per-skill read metrics: entry/sub reads, errors, avg duration      |
| `skill_sessions` | Full skill lifecycle analysis: duration, tool chains, end patterns |

### Web dashboard

Visit `http://localhost:<port>/plugins/usage-tracker/` for the interactive dashboard.

Click **Recalculate** to backfill historical data from session transcripts.

### Gateway RPC

- `usage-tracker.query` — same as the tool query action
- `usage-tracker.backfill` — trigger historical backfill
- `usage-tracker.status` — same as the tool status action

## Data storage

Per-day JSONL files at `<stateDir>/plugins/usage-tracker/data/YYYY-MM-DD.jsonl`.

Skill session records at `<stateDir>/plugins/usage-tracker/data/skill-sessions.jsonl`.
