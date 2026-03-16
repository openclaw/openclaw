# Plugin Insights

> Automatically evaluate how much your installed OpenClaw plugins actually help.

Plugin Insights is an OpenClaw plugin that tracks and analyzes the real-world effectiveness of your other plugins. It runs silently in the background, collecting data locally, and produces actionable reports so you know which plugins are worth keeping — and which ones are just wasting tokens.

## Features

- **Automatic data collection** via ContextEngine `afterTurn` hook and `after_tool_call` hook
- **Three-layer attribution**: Tool Call matching (requires `toolMappings` config for accurate results), Context Injection detection (scans all message roles including system/context), Self-Report API
- **Five evaluation metrics**: Trigger Frequency, Token Overhead, Conversation Turns, Implicit Satisfaction, LLM-as-Judge (optional, calls external API)
- **Multiple report formats**: CLI slash-commands, HTML dashboard, JSON export
- **Local-first data**: All collected data stays in a local SQLite database. No telemetry. LLM-as-Judge is opt-in and uses your own API key.

## Install

```bash
openclaw plugins install plugin-insights
```

## Usage

### Slash Commands (inside OpenClaw TUI/chat)

```
/insights-show
/insights-show --plugin memory-tools
/insights-compare memory-core memory-lancedb
/insights-export --output ./data.json --format json
/insights-dashboard --output ./dashboard.html
/insights-reset --confirm
```

### Agent Tools

You can also ask your agent directly:

- *"How effective are my plugins?"* → triggers `insights_show`
- *"Compare memory-core and memory-lancedb"* → triggers `insights_compare`

### Report Example

```
╔════════════════════════════════════════════════════════╗
║              Plugin Insights Report                    ║
║              Period: 2026-02-14 → 2026-03-16           ║
╠════════════════════════════════════════════════════════╣
║                                                        ║
║  Memory Tools          installed 30d                   ║
║  ├─ Triggered: 247 times (8.2/day)                     ║
║  ├─ Token overhead: +12% (~$0.80/mo)                   ║
║  ├─ Avg turns/session: 4.2 → 3.1 (▼26%)               ║
║  ├─ User acceptance rate: 84%                          ║
║  └─ Verdict: ✅ KEEP — strong positive impact          ║
║                                                        ║
║  Auto-Translator       installed 7d                    ║
║  ├─ Triggered: 89 times (12.7/day)                     ║
║  ├─ Token overhead: +45% (~$3.20/mo)                   ║
║  ├─ User acceptance rate: 42%                          ║
║  ├─ Retry rate after trigger: 38%                      ║
║  └─ Verdict: ❌ EXPENSIVE & LOW SATISFACTION           ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
```

## Configuration

Add to your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "plugin-insights": {
        "enabled": true,
        "dbPath": "~/.openclaw/plugin-insights.db",
        "retentionDays": 90,
        "toolMappings": [
          { "toolName": "memory_recall", "pluginId": "memory-core", "pluginName": "Memory Core" },
          { "toolName": "web_search", "pluginId": "web-tools", "pluginName": "Web Tools" }
        ],
        "llmJudge": {
          "enabled": false,
          "apiKey": "sk-...",
          "baseUrl": "https://api.openai.com/v1",
          "model": "gpt-4o-mini",
          "maxEvalPerDay": 20
        }
      }
    }
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable/disable data collection |
| `dbPath` | `~/.openclaw/plugin-insights.db` | Path to local SQLite database |
| `retentionDays` | `90` | Days of data to retain before auto-cleanup |
| `toolMappings` | `[]` | Explicit tool→plugin mappings for accurate attribution |
| `llmJudge.enabled` | `false` | Enable LLM-as-Judge quality scoring |
| `llmJudge.apiKey` | — | Your OpenAI-compatible API key |
| `llmJudge.baseUrl` | `https://api.openai.com/v1` | API base URL |
| `llmJudge.model` | `gpt-4o-mini` | Model to use for judging |
| `llmJudge.maxEvalPerDay` | `20` | Max evaluations per day (cost control) |

## How It Works

### Data Collection

Plugin Insights registers as a lightweight ContextEngine (`ownsCompaction: false`) so it can tap into the `afterTurn` lifecycle hook without affecting agent behavior. It also hooks into `after_tool_call` to observe tool calls at runtime.

### Attribution

Three layers work together to figure out which plugin caused what:

1. **Tool Call Matching** — Hooks into `after_tool_call` to observe every tool invocation at runtime. Observed tool names are matched against user-configured `toolMappings` for plugin attribution. Tools without explicit mappings are logged for diagnostics but **not** attributed to any plugin (no false positives). Built-in agent tools (e.g., `web_search`, `write_file`) are automatically excluded.
2. **Context Injection Detection** — Scans all messages — including system and context messages injected by other plugins — for known plugin markers (e.g., `[memory-core]`, `[semantic-memory]`).
3. **Self-Report API** — Plugins can write directly to the plugin-insights SQLite database for the most precise attribution. (A hook-based API is planned for a future SDK version with custom hook support.)

### Metrics

| Metric | What it measures |
|--------|------------------|
| Trigger Frequency | How often a plugin activates |
| Token Delta | Extra tokens consumed when plugin is active |
| Conversation Turns | Whether sessions are shorter (more efficient) with the plugin |
| Implicit Satisfaction | Retry/correction rates after plugin triggers |
| LLM Judge | AI-scored quality comparison (optional, uses your API key) |

## For Plugin Developers

### Accurate Attribution via toolMappings

For best results, ask your users to add your tool names to the `toolMappings` config:

```json
{
  "plugins": {
    "entries": {
      "plugin-insights": {
        "toolMappings": [
          { "toolName": "your_tool_name", "pluginId": "your-plugin-id", "pluginName": "Your Plugin" }
        ]
      }
    }
  }
}
```

### Direct Self-Reporting

For the most precise attribution, your plugin can write directly to the plugin-insights DB:

```typescript
import Database from "better-sqlite3";

// Open the shared insights DB
const db = new Database("~/.openclaw/plugin-insights.db");
db.prepare(`
  INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action, metadata_json)
  VALUES (?, ?, 'self_report', ?, ?)
`).run(turnId, "my-plugin", "recall", JSON.stringify({ count: 5 }));
```

> **Note:** A cleaner hook-based self-report API (`api.on("plugin_insights_report", ...)`) is planned for when the OpenClaw SDK supports custom hook names. The infrastructure is ready in the codebase.

## Development

```bash
npm install
npm test          # Run tests
npm run build     # Build with tsup
npm run lint      # Type check
```

## Tech Stack

- TypeScript, Node.js
- better-sqlite3 (local storage)
- Vitest (testing)
- tsup (bundling)

## License

MIT
