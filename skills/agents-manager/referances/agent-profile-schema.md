# Agent Profile Schema

Standard profile structure for each agent.

## Profile Fields

```yaml
id: "agent-id"                    # Unique agent identifier
name: "Display Name"               # Human-readable name
model: "model-name"                # e.g., "glm-4.7", "claude-opus-4.5"
created: "2026-01-31"              # Agent creation date
last_updated: "2026-01-31T17:00Z"  # Last profile update

capabilities:                      # What the agent can do
  - "capability-1"
  - "capability-2"

tools:                            # Available tools/API access
  - "tool-name"

communication:                    # How to reach this agent
  method: "direct"                 # direct | spawn | webhook
  sessionKey: "agent:main:main"    # For direct messaging
  notes: "Additional notes"

# NEW: Agent routing
can_assign_to:                     # Agents this one can delegate tasks to
  - "agent-id-1"
  - "agent-id-2"

reports_to:                       # Who this agent reports to
  type: "agent"                    # agent | human
  target: "agent-id or name"       # Agent ID or human name
  method: "message"                # How to report (sessions_send, message, etc.)

escalation_path:                  # Escalation hierarchy (bottom-up)
  - level: 1
    type: "agent"
    target: "supervisor-agent"
  - level: 2
    type: "human"
    target: "Ilkerkaan"
    method: "telegram"

completed_work:                    # Track what was done
  - date: "2026-01-31"
    task: "Task description"
    status: "completed"

preferences:                       # Agent preferences
  language: "tr,en"                # Supported languages
  timezone: "UTC+3"
  notes: "Any preferences"
```

## Required Fields

- `id` - Unique identifier
- `name` - Display name
- `model` - Model name
- `capabilities` - At least one capability
- `reports_to` - Who to report to (agent or human)

## Optional Fields

- `tools` - Tool access list
- `communication` - How to contact
- `can_assign_to` - Delegation targets
- `escalation_path` - Escalation hierarchy
- `completed_work` - Task history
- `preferences` - Agent preferences
