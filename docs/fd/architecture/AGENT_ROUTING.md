# Agent Routing — Multi-Agent Architecture

## Agent Map

### Full Digital (Agency)

| Agent | Purpose | Model | Channel |
|-------|---------|-------|---------|
| `fulldigital-ops` | Command center, approvals, summaries | qwen3.5:9b | TG Ops |
| `fulldigital-sales` | Lead follow-up, outreach, proposals | qwen3.5:9b | TG Sales |
| `fulldigital-content` | Captions, calendars, hooks, campaigns | qwen3.5:4b | TG Content |
| `fulldigital-finance` | Grants, bookkeeping, reports | qwen3.5:9b | TG Finance |

### CUTMV (SaaS)

| Agent | Purpose | Model | Channel |
|-------|---------|-------|---------|
| `cutmv-ops` | Roadmap, bugs, infrastructure | qwen3.5:9b | TG Ops |
| `cutmv-support` | Customer help, FAQs, onboarding | qwen3.5:4b | TG Support |
| `cutmv-growth` | Promos, campaigns, announcements | qwen3.5:9b | TG Growth |

## Routing Flow

```
Inbound message
    │
    ▼
Gateway (M4) receives on channel
    │
    ▼
Match channel → brand binding (fulldigital.json / cutmv.json)
    │
    ▼
Match intent → specific agent (by triggers or default)
    │
    ▼
Agent workspace loaded (SOUL.md + tools)
    │
    ▼
Inference routed to appropriate model/node
    │
    ▼
Response sent back through channel
```

## Routing Rules

### Channel-Based Routing
Each Telegram chat is bound to a specific agent. The Gateway matches
the inbound `chat_id` to the binding config to determine which agent handles it.

### Trigger-Based Routing
Within a brand, messages can be re-routed based on keyword triggers.
For example, a message containing "grant" in the FD ops channel would
route to `fulldigital-finance`.

### Default Routing
Unmatched messages within a brand go to the ops agent for that brand.

## Inference Routing

| Condition | Target | Model |
|-----------|--------|-------|
| Simple FAQ or greeting | M4 local | qwen3.5:2b |
| Normal agent work | M1 Ollama | qwen3.5:9b |
| Content generation (bulk) | M1 Ollama | qwen3.5:4b |
| Complex analysis / long context | Cloud | claude-sonnet-4-6 |
| Long-running job | Worker queue | (deferred) |

## Scheduled Agent Tasks

| Schedule | Agent | Task |
|----------|-------|------|
| Daily 6:00 AM ET | fulldigital-finance | Grant scan |
| Daily 8:00 AM ET (Mon-Fri) | fulldigital-ops | Daily digest |
| Daily 9:00 AM ET (Mon-Fri) | fulldigital-sales | Pipeline health check |
| Weekly Mon 10:00 AM ET | fulldigital-content | Content planning |
| Daily 7:00 AM ET (Mon-Fri) | cutmv-ops | Metrics snapshot |

## Agent Isolation

Each agent has its own workspace directory with:
- `SOUL.md` — personality, responsibilities, safety rules
- `AGENTS.md` — configuration, model, bindings (optional)

Agents cannot access each other's workspaces. Cross-agent communication
happens through the Gateway event bus or shared storage (Notion, DB).
