---
name: agents-manager
description: |
  Manage Clawdbot agents: discover, profile, track capabilities, define routing hierarchy, and assign tasks.
  Use when: (1) Listing available agents, (2) Profiling agent capabilities and communication methods,
  (3) Defining agent routing (can_assign_to, reports_to, escalation_path), (4) Assigning tasks to appropriate agents,
  (5) Tracking agent performance and completed work, (6) Updating agent registry after changes.
---

# Agents Manager

## Overview

Manage all Clawdbot agents centrally: discover available agents, profile their capabilities, define routing hierarchy (who can assign to whom, who reports to whom), and intelligently route new tasks through the escalation chain.

---

## Quick Start

**List all agents:** Run `agents list` to see available agent IDs and models.

**Profile agents:** Run `agents profile` to query each agent about capabilities and routing configuration.

**Assign task:** Run `agents assign "<task>"` to route task through the escalation chain.

---

## Core Capabilities

### 1. Agent Discovery

List all available agents using `agents_list` tool:
- Returns agent IDs you can target with sessions_spawn
- Filter by agent type/model if needed

### 2. Agent Profiling

Query each agent to build capability profile with routing:

**Ask each agent:**
- What is your primary model and capabilities?
- Which tools do you have access to?
- What types of tasks can you handle?
- **Who can you assign tasks to?** (can_assign_to)
- **Who do you report to?** (reports_to)
- **What is your escalation path?** (escalation_path)

**Profile format:** See [agent-profile-schema.md](references/agent-profile-schema.md)

### 3. Routing Configuration

Define agent hierarchy:

**`can_assign_to`** - Agents this one can delegate to:
- List of agent IDs that accept delegation from this agent
- Used for horizontal routing (peer delegation)

**`reports_to`** - Who this agent reports to:
- type: `agent` or `human`
- target: Agent ID or human name
- method: How to send report (sessions_send, message, etc.)

**`escalation_path`** - Escalation hierarchy (bottom-up):
- Level 1: Direct supervisor (agent)
- Level 2: Human owner
- Level N+: Additional escalation levels

### 4. Task Assignment

When a user requests work that could be handled by another agent:

```
1. Analyze task type (SAP, coding, research, etc.)
2. Check [agent-registry.md](references/agent-registry.md) for matching agent
3. Check current agent's `can_assign_to` list
4. Choose communication method:
   - Existing session → `sessions_send`
   - New session → `sessions_spawn`
   - Human notification → `message`
5. Route task with context and report-to instruction
```

**Example flow:**
```
User: "ABAP report for FI invoices"
→ Check registry: FICO agent exists
→ Check main.can_assign_to: includes FICO
→ sessions_send(sessionKey, task, reportTo='main')
```

### 5. Agent Registry Tracking

Maintain [agent-registry.md](references/agent-registry.md) with:
- Agent ID, name, model
- Capabilities and tools
- Communication methods
- **Routing configuration (can_assign_to, reports_to, escalation_path)**
- Completed work log
- Last updated timestamp

**Update registry:**
- After profiling new agents
- When agents learn new capabilities
- After completed tasks (log work)
- When routing hierarchy changes

### 6. Escalation Protocol

When an agent cannot complete a task:

```
1. Try can_assign_to → delegate to peer
2. If no peer can help → reports_to (supervisor)
3. If supervisor is human → message notification
4. Follow escalation_path until resolved
```

---

## Resources

### references/

**[agent-profile-schema.md](references/agent-profile-schema.md)** - Agent profile structure with routing fields

**[agent-registry.md](references/agent-registry.md)** - Live registry of all agents with capabilities and routing

**[task-routing-rules.md](references/task-routing-rules.md)** - Decision rules and escalation flows

### scripts/

**[scan_agents.js](scripts/scan_agents.js)** - Script to discover and profile all agents automatically

---

## When to Use This Skill

- User asks "list all agents" or "what agents are available?"
- User mentions assigning work to another agent
- You need to define who reports to whom
- You need to update escalation path
- Checking if a specialized agent exists for a task
- Tracking what work was done by which agent
- Agent cannot complete task and needs escalation
