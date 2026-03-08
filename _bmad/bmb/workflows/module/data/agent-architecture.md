# Agent Architecture for Modules

**Purpose:** High-level guidance for planning agents in your module — not implementation details (that's what the agent-builder workflow is for).

---

## Single Agent vs. Multi-Agent Module

### Single Agent Module

**Use when:** One persona can handle the module's purpose.

**Characteristics:**

- Simpler, focused
- Clear single point of contact
- Good for narrow domains

**Question:** Could one expert agent with a sidecar handle this entire module?

---

### Multi-Agent Module

**Use when:** Different expertise areas justify specialized personas.

**Characteristics:**

- Each agent has a distinct role and expertise
- Agents form a cohesive team around the module's theme
- Menus coordinate to guide users to the right agent

**Why multi-agent?**

- Different workflows need different expert perspectives
- Users expect to talk to "the right expert" for each task
- The module covers a domain too broad for one persona

---

## Flagship Example: BMM Agent Team

BMM demonstrates a multi-agent module with **9 specialized agents** forming a complete software development team.

### The BMM Theme

**"Agile software delivery, AI-driven"**

Every agent serves this theme — they're a complete team working together.

### BMM Agent Overview

| Agent       | Name    | Role                    | Responsible For                  |
| ----------- | ------- | ----------------------- | -------------------------------- |
| PM          | John    | Product Manager         | PRDs, requirements, user stories |
| Architect   | Winston | System Architect        | Technical design, architecture   |
| UX          |         | UX Designer             | User research, UX design         |
| Dev         |         | Developer               | Implementation, coding           |
| TEA         |         | Test Engineer Architect | Test architecture, QA            |
| SM          |         | Scrum Master            | Sprint planning, workflow status |
| Tech Writer |         | Technical Writer        | Documentation                    |
| Analyst     |         | Business Analyst        | Analysis, metrics                |
| Quick Flow  |         | Solo Developer          | Quick standalone work            |

### Key Patterns

1. **Shared commands** — All agents have `[WS]` Workflow Status
2. **Specialty commands** — Each agent has unique commands (PM→PRD, Architect→Architecture)
3. **No overlap** — Each command has one clear owner
4. **Collaboration** — Agents reference each other's work (PRD → Architecture → Implementation)

---

## Planning Your Agents

### For Each Agent, Document:

1. **Role** — What is this agent responsible for?
2. **Workflows** — Which workflows will this agent trigger/own?
3. **Human Name** — What's their persona name? (e.g., "John", "Winston")
4. **Communication Style** — How do they talk? (e.g., "Direct and data-sharp", "Calm and pragmatic")
5. **Skills/Expertise** — What knowledge does this agent bring?
6. **Memory/Learning** — Does this agent need to remember things over time? (hasSidecar)

That's it! The agent-builder workflow will handle the detailed implementation.

---

## Agent Memory & Learning

### Sidecar Agents (hasSidecar: true)

**Use when:** The agent needs to remember context across sessions.

**Characteristics:**

- Has a sidecar file that persists between conversations
- Learns from user interactions
- Remembers project details, preferences, past work

**Examples:**

- An agent that tracks project decisions over time
- An agent that learns user preferences
- An agent that maintains ongoing project context

### Stateless Agents (hasSidecar: false)

**Use when:** The agent doesn't need persistent memory.

**Characteristics:**

- Each conversation starts fresh
- Relies on shared context files (like project-context.md)
- Simpler, more predictable

**Most module agents are stateless** — they reference shared project context rather than maintaining their own memory.

---

## Agent-Workflow Coordination

### Menu Triggers

Each agent has menu items that trigger workflows:

| Trigger Type    | Pattern                            | Example                     |
| --------------- | ---------------------------------- | --------------------------- |
| Shared          | Same across all agents             | `[WS]` Workflow Status      |
| Specialty       | Unique to this agent               | `[PR]` Create PRD (PM only) |
| Cross-reference | Points to another agent's workflow | "See architecture"          |

### Simple Planning Format

For each agent, just document:

```
Agent: PM (John)
Role: Product Manager, requirements, PRDs
Triggers:
  - WS → Workflow Status (shared)
  - PR → Create PRD (specialty)
  - ES → Epics and Stories (specialty)
Memory: No (uses shared project-context)
```

The agent-builder workflow will convert this into the proper format.

---

## When to Use Multiple Agents

**Consider multiple agents when:**

- Different workflows require different expertise
- The domain has clear specialization areas
- Users would expect to talk to different "experts"
- The module covers a broad process (like software development)

**Use a single agent when:**

- The domain is focused and narrow
- One expertise area covers all workflows
- Simplicity is preferred
- The agent could reasonably handle everything with a sidecar

---

## Quick Agent Planning Checklist

For each agent in your module:

- [ ] Role defined (what they're responsible for)
- [ ] Workflows assigned (which workflows they trigger)
- [ ] Human name chosen (persona)
- [ ] Communication style described
- [ ] Skills/expertise identified
- [ ] Memory decision (hasSidecar: true/false)

---

## Notes

- **Don't worry about the exact YAML format** — agent-builder handles that
- **Focus on the planning** — who does what, how they work together
- **Keep it high-level** — this is about the module's agent architecture, not implementation details
- **BMM is the reference** — look at how their agents form a cohesive team
