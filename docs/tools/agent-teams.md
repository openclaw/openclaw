---
summary: "Agent Teams: coordinate multiple AI agents with shared task ledger and mailbox protocol"
read_when:
  - You want multiple agents to collaborate on complex tasks
  - You need parallel task distribution with dependency management
  - You are implementing team-based workflows
title: "Agent Teams"
---

# Agent Teams

Agent Teams enable multiple AI agents to collaborate on complex tasks through a shared task ledger and mailbox protocol. Teams consist of a **Team Lead** and multiple **Teammates** working in parallel.

## When to Use Teams vs Sub-agents

Use **Agent Teams** when:

- Tasks can be decomposed into independent parallel work
- Multiple agents need to coordinate on a shared goal
- Work requires different specialized agent types
- Tasks have dependencies requiring sequential execution

Use **Sub-agents** (via `sessions_spawn`) when:

- You need simple background work without coordination
- Tasks are one-shot and don't require peer communication
- A single agent can handle the work independently

## Quick Start

<Steps>
  <Step title="Create a team">

Use `team_create` to create a new team:

```typescript
team_create({
  team_name: "my-team",
  description: "Building feature X",
});
```

Team names must be 1-50 characters, using lowercase letters, numbers, hyphens, and underscores.

  </Step>

  <Step title="Spawn teammates">

Spawn team members with different agent types:

```typescript
// TeammateSpawn is automatic when using Task tool with team_name
// Or spawn via sessions_spawn with team context
```

Available agent types include: `general-purpose`, `Explore`, `Plan`, `refactor:code-simplifier`, and others defined in `.claude/agents/`.

  </Step>

  <Step title="Create and distribute tasks">

Add tasks to the shared ledger:

```typescript
task_create({
  subject: "Implement API endpoint",
  description: "Create REST API for user management",
  activeForm: "Implementing API endpoint",
});
```

Teammates automatically claim and complete tasks.

  </Step>

  <Step title="Shutdown when done">

Gracefully shutdown the team:

```typescript
team_shutdown({ team_name: "my-team" });
```

  </Step>
</Steps>

## Core Tools

| Tool            | Purpose                                    |
| --------------- | ------------------------------------------ |
| `team_create`   | Create a new team with config and ledger   |
| `team_shutdown` | Graceful shutdown with member approval     |
| `task_create`   | Add tasks with optional dependencies       |
| `task_list`     | Query tasks by status/owner                |
| `task_claim`    | Atomically claim a specific task           |
| `task_complete` | Mark task complete, unblock dependents     |
| `send_message`  | Direct/broadcast messaging between members |
| `inbox`         | Read pending messages                      |

## Task Lifecycle

```
pending → claimed → in_progress → completed
                    ↓
                  failed
```

- **pending**: Task is available for claiming
- **claimed**: A teammate has claimed the task
- **in_progress**: Work has started
- **completed**: Task finished successfully
- **failed**: Task encountered an error

### Task Dependencies

Tasks can depend on other tasks using `dependsOn`:

```typescript
task_create({
  subject: "Write API docs",
  description: "Document the user API",
  dependsOn: ["task-123"], // Waits for task-123 to complete
});
```

Dependent tasks remain blocked until all dependencies complete.

## Communication

### Direct Messages

Send to a specific teammate:

```typescript
send_message({
  team_name: "my-team",
  type: "message",
  recipient: "researcher",
  content: "API docs are ready for review",
  summary: "API docs ready",
});
```

### Broadcast

Send to all team members:

```typescript
send_message({
  team_name: "my-team",
  type: "broadcast",
  content: "Sprint planning in 10 minutes",
  summary: "Sprint planning",
});
```

### Reading Messages

Teammates poll their inbox:

```typescript
inbox({ team_name: "my-team" });
```

Messages are delivered automatically to session-specific inbox directories.

## Shutdown Protocol

Graceful shutdown requires member approval:

1. `team_shutdown` sends `shutdown_request` to all active members
2. Members respond with `shutdown_response` (approve/reject)
3. Team is deleted once all members approve

If members are unresponsive, the team remains active.

## Directory Structure

```
~/.openclaw/teams/
└── {team_name}/
    ├── config.json     # Team configuration
    ├── ledger.db       # SQLite database (tasks, members, messages)
    └── inbox/          # Per-session message directories
        └── {session_key}/
            └── messages.jsonl
```

## Resource Limits

| Limit                | Value             |
| -------------------- | ----------------- |
| Max teams            | 10                |
| Max members per team | 10                |
| Max tasks per team   | 1000              |
| Max message size     | 100KB             |
| Max task description | 10,000 characters |
| Max task subject     | 200 characters    |

## Best Practices

### Task Decomposition

- Break large tasks into focused units
- Make tasks independent when possible
- Keep dependency chains short (< 5 tasks)
- Use `activeForm` for progress indicators

### Team Size

- **Small**: 2-3 members for simple coordination
- **Medium**: 4-6 members for moderate complexity
- **Large**: 7-10 members for complex projects

### Team Communication

- Use broadcasts sparingly
- Prefer direct messages for coordination
- Summarize long content for UI previews
- Let work results speak over chatter

## Comparison with Sub-agents

| Feature       | Agent Teams           | Sub-agents              |
| ------------- | --------------------- | ----------------------- |
| Communication | Peer-to-peer          | Announce to parent only |
| Task sharing  | Shared ledger         | Independent             |
| Dependencies  | Supported             | Not supported           |
| Coordination  | Explicit              | Implicit via announce   |
| Use case      | Complex collaboration | Background work         |

See [Sub-agents](/tools/subagents) for background/parallel work without coordination needs.
