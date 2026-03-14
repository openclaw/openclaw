# Agent Tracing System Design

## Goal

Let any OpenClaw instance trace tool calls, LLM invocations, and sub-agent relationships with zero external dependencies. Users install a plugin and immediately get tree-view visibility into agent execution.

## Architecture: Two Layers

### Layer 1: Default (zero-dependency)

Plugin `extensions/tracing` — JSONL + CLI/Web viewer.

```
OpenClaw hooks ──► TraceSpan ──► ~/.openclaw/traces/<date>.jsonl
                                        │
                          ┌──────────────┼──────────────┐
                          ▼              ▼              ▼
                   CLI tree view   Web UI /traces   Waterfall
```

User experience:

- `openclaw plugins install tracing` — done
- `openclaw traces` — CLI tree view
- Web UI at `/traces` — interactive viewer

### Layer 2: Optional advanced (PuppyGraph)

For users who want arbitrary graph queries and advanced visualization.

```
TraceSpan ──► SQLite/DuckDB (same data, tabular format)
                    │
              PuppyGraph (Docker, free Developer Edition)
                    │
              Cypher/Gremlin queries + built-in graph UI
```

User experience:

- `openclaw config set tracing.storage sqlite` — switch to SQLite output
- `docker run puppygraph` + point at SQLite file
- Query: `MATCH (a:Agent)-[:SPAWNED]->(b:Agent) RETURN a, b`

## Data Model

```typescript
type TraceSpan = {
  traceId: string; // shared across entire top-level session
  spanId: string; // unique per span
  parentSpanId?: string; // links to parent (null = root)
  kind: "session" | "llm_call" | "tool_call" | "subagent";
  name: string;
  agentId?: string;
  sessionKey?: string;
  startMs: number;
  endMs?: number;
  durationMs?: number;
  attributes: Record<string, string | number | boolean>;
  // tool_call
  toolName?: string;
  toolParams?: Record<string, unknown>;
  // subagent
  childSessionKey?: string;
  childAgentId?: string;
  // llm_call
  provider?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
};
```

Two trees derived from one data model:

- **Call tree**: nest by `parentSpanId`, sort by `startMs`
- **Entity relationship tree**: filter `kind === "subagent"`, build `agentId → childAgentId` graph

## Hook Registration

| Hook                | Span kind           | Action                               |
| ------------------- | ------------------- | ------------------------------------ |
| `session_start`     | `session` (open)    | Create root span, assign traceId     |
| `session_end`       | `session` (close)   | Set endMs, durationMs                |
| `llm_input`         | `llm_call` (open)   | Record provider, model, tokensIn     |
| `llm_output`        | `llm_call` (close)  | Set tokensOut, durationMs            |
| `before_tool_call`  | `tool_call` (open)  | Record toolName, toolParams          |
| `after_tool_call`   | `tool_call` (close) | Set result summary, durationMs       |
| `subagent_spawning` | `subagent` (open)   | Record childAgentId, childSessionKey |
| `subagent_ended`    | `subagent` (close)  | Set durationMs                       |

### Parent chain logic

- session span: root (no parent)
- llm_call parent = current session span
- tool_call parent = triggering llm_call span
- subagent parent = triggering tool_call span (sessions_spawn)
- child agent's session span parent = parent agent's subagent span
- traceId propagates from top-level session through all descendants

## CLI Viewer: `openclaw traces`

Three view modes:

### Call tree (default: `openclaw traces --mode call`)

```
└─ research-bot (session:main-abc) 12.0s
   ├─ llm [anthropic/claude-sonnet-4-20250514] 1.4s [in:2800 out:350]
   │  ├─ web_search (query=...) 1.3s
   │  └─ read_url (url=...) 400ms
   ├─ llm [anthropic/claude-sonnet-4-20250514] 1.3s
   │  └─ → translator-bot (session:translator-def) 5.0s
   │     └─ translator-bot (session:translator-def) 4.8s
   │        ├─ llm [openai/gpt-4o] 1.1s
   │        │  ├─ translate (from=en, to=zh) 400ms
   │        │  └─ → summarizer-bot 2.0s
   ...
```

### Entity tree (`openclaw traces --mode entity`)

```
└─ research-bot (session:main-abc) 12.0s
   │ 3 LLM calls  3 tool calls  tokens: 14500→1430
   │ models: claude-sonnet-4-20250514
   │ tools: web_search, read_url, send_message
   └─ translator-bot 4.8s
      │ 2 LLM calls  1 tool calls  tokens: 8000→770
      └─ summarizer-bot 1.8s
```

### Waterfall (`openclaw traces --mode waterfall`)

Timeline bar chart showing parallel/sequential execution.

### Both (`openclaw traces` with no flag)

Shows all three views.

## Storage

### Layer 1: JSONL (default)

- Path: `~/.openclaw/traces/YYYY-MM-DD.jsonl`
- One JSON object per line
- Auto-rotate daily, configurable retention (`tracing.retentionDays`, default 7)

### Layer 2: SQLite/DuckDB (opt-in)

- Path: `~/.openclaw/traces/traces.db`
- Single `spans` table matching TraceSpan schema
- Enables PuppyGraph connection

## Configuration

```yaml
tracing:
  enabled: true # default: false
  storage: jsonl # jsonl | sqlite
  retentionDays: 7
  redactToolParams: false # strip tool params from output
```

## Plugin Structure

```
extensions/tracing/
  package.json
  index.ts              # plugin registration
  src/
    collector.ts        # hook handlers, span lifecycle
    storage-jsonl.ts    # JSONL writer
    storage-sqlite.ts   # SQLite writer (optional)
    viewer-cli.ts       # CLI tree renderer
    types.ts            # TraceSpan type
```

## Non-Goals (for now)

- Real-time streaming UI
- Distributed tracing across multiple OpenClaw instances
- Integration with existing APM tools (covered by diagnostics-otel)
- Token cost analytics (covered by diagnostics-otel metrics)
