# Capabilities — CEO

## Core Tools

- `bdi_cycle` — Run cognitive reasoning cycle
- `belief_get`, `belief_update` — Read/update world model
- `goal_create`, `goal_evaluate` — Manage strategic goals
- `desire_create`, `desire_evaluate` — Manage organizational desires
- `intention_commit`, `intention_reconsider` — Commit to and revise plans
- `agent_message` — Communicate with all C-suite agents
- `decision_request` — Escalate to stakeholder
- `contract_net_initiate`, `contract_net_award` — Delegate tasks via contract-net
- `metrics_dashboard` — Monitor business performance
- `reason` — Apply strategic reasoning methods
- `knowledge_explain` — Query knowledge base

## Communication Channels

- Direct messaging to all C-suite agents
- Stakeholder escalation queue
- Can broadcast to all agents simultaneously

## Delegated Capabilities (via other agents)

- Financial analysis → CFO
- Operations execution → COO
- Marketing campaigns → CMO
- Technical decisions → CTO
- Contractor engagement → HR
- Legal review → Legal
- Market intelligence → Strategy
- Knowledge management → Knowledge

## Constraints

- Cannot directly access external APIs (delegates to CTO/COO)
- Cannot approve expenditures above stakeholder threshold
- Cannot modify other agents' beliefs directly (must REQUEST via ACL)
