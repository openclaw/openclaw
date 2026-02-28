# A2A Reasoning Tools Implementation

This branch implements the `agent_call` and `debate_call` tools for structured agent-to-agent communication with confidence tracking.

## New Files

```
src/agents/tools/
├── agent-call-tool.ts      # Structured delegation to agents
├── debate-call-tool.ts     # Multi-agent debate orchestration
└── debate-call-tool.test.ts # Tests for debate_call
```

## What Each Tool Does

### agent_call

Structured delegation to another agent with:

- Input/output schema validation (future)
- Confidence tracking (agents return `confidence` in output)
- Assumption tracking (agents return `assumptions`)
- Mode support (`execute` | `critique`)

**Usage:**

```typescript
{
  "agent": "rca-agent",
  "skill": "propose_cause",
  "input": { "failure_event": {...} },
  "mode": "execute",  // or "critique"
  "timeoutSeconds": 60
}
```

**Returns:**

```typescript
{
  "status": "completed",
  "output": {...},
  "confidence": 0.85,
  "assumptions": ["Maintenance logs complete"],
  "caveats": ["No sensor data available"]
}
```

### debate_call

Multi-agent debate with:

- Proposer → Critics → Resolver pattern
- Confidence progression tracking
- Early stopping when confidence threshold reached
- Round-by-round refinement

**Usage:**

```typescript
{
  "topic": "Root cause analysis for pump failure",
  "proposer": { "agent": "rca-agent", "skill": "propose_cause" },
  "critics": [
    { "agent": "maintenance-agent", "perspective": "maintenance_history" },
    { "agent": "operations-agent", "perspective": "runtime_context" }
  ],
  "resolver": { "agent": "rca-resolver", "skill": "synthesize" },
  "input": { "failure_event": {...} },
  "rounds": 2,
  "minConfidence": 0.85
}
```

**Returns:**

```typescript
{
  "status": "resolved",
  "conclusion": {...},
  "confidence": 0.88,
  "confidenceHistory": [0.65, 0.72, 0.82, 0.88],
  "rounds": [{...}],
  "dissent": "Minor concern about sensor data",
  "assumptions": ["Maintenance logs complete", "Operator reports accurate"]
}
```

## Integration

### 1. Register Tools in `openclaw-tools.ts`

```typescript
import { createAgentCallTool } from "./tools/agent-call-tool.js";
import { createDebateCallTool } from "./tools/debate-call-tool.js";

// In createOpenClawTools():
const tools: AnyAgentTool[] = [
  // ... existing tools ...
  createAgentCallTool({
    agentSessionKey: options?.agentSessionKey,
    agentChannel: options?.agentChannel,
    sandboxed: options?.sandboxed,
  }),
  createDebateCallTool({
    agentSessionKey: options?.agentSessionKey,
    agentChannel: options?.agentChannel,
  }),
];
```

### 2. Tool Policy

Add to `tools.allow` in config if needed:

```yaml
tools:
  allow:
    - agent_call
    - debate_call
```

### 3. A2A Policy

Enable cross-agent calls:

```yaml
tools:
  agentToAgent:
    enabled: true
    allow: ["*"] # Or specific agents
```

## Testing

```bash
# Run tests
pnpm test src/agents/tools/debate-call-tool.test.ts

# Build
pnpm build
```

## Design Decisions

### Reuses existing infrastructure

- Uses `callGateway` for agent invocation (same as `sessions_send`)
- Uses `agent.wait` for synchronous waiting
- Uses `chat.history` to retrieve results
- Uses `AGENT_LANE_NESTED` for proper message handling

### Structured output parsing

Agents are expected to return JSON with:

- `output`: The actual result
- `confidence`: 0-1 number (default 0.5 if not provided)
- `assumptions`: string[] (optional)
- `caveats`: string[] (optional)

If JSON parsing fails, falls back to raw text with confidence 0.5.

### Debate flow

1. **Round 0**: Proposer generates initial proposal
2. **Critique rounds**: Critics parallelly critique, proposer refines
3. **Early stop**: If confidence >= minConfidence, skip remaining rounds
4. **Resolution**: Resolver synthesizes final result

### Error handling

- Individual critic failures are caught and reported
- Debates return error status if proposer/resolver fail
- Partial results are included in error responses

## Future Enhancements

### Schema validation (Phase 2)

Agent Cards with JSON Schema:

```yaml
a2a:
  skills:
    - name: propose_cause
      inputSchema: { type: "object", properties: { ... } }
      outputSchema: { type: "object", properties: { ... } }
```

### BPMN integration

Debate as BPMN service task:

```xml
<serviceTask id="debate" type="debateCall">
  <property name="topic" value="${failure.description}" />
  <proposer agent="rca-agent" skill="propose" />
  <critics>
    <critic agent="maintenance-agent" perspective="maintenance" />
  </critics>
  <resolver agent="rca-resolver" skill="synthesize" />
</serviceTask>
```

### Federation (Phase 3)

Cross-instance agent calls:

```yaml
a2a:
  federation:
    instances:
      - id: production
        url: https://clawd.example.com/a2a
```

## References

- Design document: `zettelkasten/sources/2026_OpenClaw_A2A_Integration_Proposal_v2.md`
- Research synthesis: `zettelkasten/notes/202602141430_A2A_Reasn_Enhanced_Research.md`
