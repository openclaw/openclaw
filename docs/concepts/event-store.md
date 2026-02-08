---
summary: "Persistent event streaming for AI agents via NATS JetStream"
read_when:
  - You want to enable persistent event storage
  - You want temporal queries across agent history
  - You want to extract training data from conversations
---

# Event Store

Event Store provides persistent, replayable storage of all agent events via
[NATS JetStream](https://docs.nats.io/nats-concepts/jetstream). Every message,
tool call, and lifecycle event becomes a permanent record — enabling temporal
queries, training data extraction, and full audit trails.

## Quick Start

Enable Event Store in your config:

```yaml
eventStore:
  enabled: true
  natsUrl: nats://localhost:4222
```

Start NATS with JetStream:

```bash
docker run -p 4222:4222 nats:latest -js
```

That's it — OpenClaw will now stream all agent events to NATS.

## Key Capabilities

### 1. Temporal Queries

Ask "what happened on February 2nd?" and replay events from that exact time:

```bash
# Get events from a specific time range
nats consumer next openclaw-events query \
  --start-time "2026-02-02T10:00:00Z" \
  --batch 100
```

### 2. Multi-Agent Isolation

Each agent gets its own subject namespace:

```
openclaw.events.main.conversation.message_in
openclaw.events.viola.conversation.tool_call
openclaw.events.mona.lifecycle.session_start
```

Query events for a specific agent:

```bash
nats sub "openclaw.events.viola.>"
```

### 3. Training Data Extraction

Export high-quality conversation pairs for fine-tuning:

```bash
# Extract training data from last 7 days
node scripts/learning/training-data-extractor.mjs 168

# Output formats:
# - training-data/openai-YYYY-MM-DD.jsonl (OpenAI fine-tuning)
# - training-data/alpaca-YYYY-MM-DD.json (Local LoRA training)
```

### 4. Real-Time Streaming

Build dashboards that visualize agent activity in real-time:

```javascript
// WebSocket subscription example
const sub = nc.subscribe("openclaw.events.>");
for await (const msg of sub) {
  const event = JSON.parse(msg.data);
  console.log(`${event.type}: ${event.payload.text?.slice(0, 50)}`);
}
```

## Configuration

```yaml
eventStore:
  # Enable/disable event streaming
  enabled: true

  # NATS server URL (supports authentication)
  # Format: nats://[user:pass@]host:port
  natsUrl: nats://localhost:4222

  # JetStream stream name
  streamName: openclaw-events

  # Subject prefix for all events
  subjectPrefix: openclaw.events

  # Optional retention limits
  retention:
    maxMessages: 1000000 # Max messages to retain
    maxBytes: 10737418240 # Max bytes (10GB)
    maxAgeHours: 720 # Max age (30 days)
```

### NATS Authentication

For production deployments with authentication:

```yaml
eventStore:
  enabled: true
  natsUrl: nats://claudia:secret@nats.example.com:4222
```

## Event Types

| Type                       | Description              |
| -------------------------- | ------------------------ |
| `conversation.message_in`  | User message received    |
| `conversation.message_out` | Assistant response sent  |
| `conversation.tool_call`   | Tool invocation started  |
| `conversation.tool_result` | Tool execution completed |
| `lifecycle.session_start`  | New session began        |
| `lifecycle.session_end`    | Session ended            |
| `lifecycle.compaction`     | Context was compacted    |
| `lifecycle.error`          | Error occurred           |

## Event Structure

```typescript
type ClawEvent = {
  id: string; // Unique event ID (ULID-style)
  timestamp: number; // Unix timestamp (ms)
  agent: string; // Agent ID (e.g., "main", "viola")
  session: string; // Session key
  type: EventType; // Event type
  visibility: "public" | "internal" | "confidential";
  payload: {
    // Event-specific data
    text?: string;
    name?: string; // Tool name
    args?: Record<string, unknown>;
    result?: unknown;
  };
  meta: {
    seq: number; // JetStream sequence number
    stream: string; // Stream name
  };
};
```

## Working with QMD

Event Store complements (not replaces) the QMD memory backend:

| Capability       | Event Store | QMD         |
| ---------------- | ----------- | ----------- |
| Semantic search  | ❌          | ✅          |
| Temporal queries | ✅          | ❌          |
| Training data    | ✅          | ❌          |
| Multi-agent      | ✅ Native   | ~ Per-agent |
| Event replay     | ✅          | ❌          |

**Best practice:** Use both together. Event Store captures everything; QMD
indexes what's searchable.

## Monitoring

Check Event Store status:

```bash
# Stream info
nats stream info openclaw-events

# Watch events in real-time
nats sub "openclaw.events.>" --last 10
```

## Troubleshooting

### Connection Failed

```
[event-store] Failed to initialize: Error: connect ECONNREFUSED
```

**Fix:** Ensure NATS is running with JetStream enabled:

```bash
docker run -p 4222:4222 nats:latest -js
```

### Events Not Persisting

```
[event-store] Disabled by config
```

**Fix:** Set `eventStore.enabled: true` in your config.

### Stream Missing

If the stream doesn't exist, OpenClaw creates it automatically on startup.
To manually create:

```bash
nats stream add openclaw-events \
  --subjects "openclaw.events.>" \
  --retention limits \
  --storage file
```

## See Also

- [Memory](/concepts/memory) — File-based memory and QMD backend
- [Session Management](/reference/session-management-compaction) — Context
  compaction and session lifecycle
