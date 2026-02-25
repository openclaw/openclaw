# Agent Teams BDD Specifications

## Overview

This document consolidates all BDD scenarios for the Agent Teams MVP. Scenarios are organized by feature area and expressed in Gherkin (Given/When/Then) format.

**Total Scenarios:** 84
**Feature Files:** 5

## Testing Strategy

### Framework

- **Primary**: Vitest for unit/integration tests
- **BDD**: Cucumber/Gherkin-compatible scenarios for behavior validation

### Coverage Targets

- Unit tests: Individual components (SQLite operations, tool handlers)
- Integration tests: Tool interactions and protocol flow
- Concurrency tests: Race condition prevention and atomic operations
- E2E tests: Complete team lifecycle workflows

### Test Organization

```
src/teams/
├── tools/
│   ├── team-create.ts
│   ├── team-create.test.ts
│   ├── teammate-spawn.ts
│   ├── teammate-spawn.test.ts
│   ├── task-create.ts
│   ├── task-create.test.ts
│   ├── task-claim.ts
│   ├── task-claim.test.ts
│   ├── task-complete.ts
│   ├── task-complete.test.ts
│   ├── send-message.ts
│   └── send-message.test.ts
├── manager.ts
├── manager.test.ts
└── ...
```

## Feature 1: Team Lifecycle

### Scenarios: 11

| #   | Scenario Description                                |
| --- | --------------------------------------------------- |
| 1   | Create a new team successfully                      |
| 2   | Create team with custom agent type for team lead    |
| 3   | Create team with descriptive metadata               |
| 4   | Attempt to create team with invalid name            |
| 5   | Attempt to create duplicate team                    |
| 6   | Graceful team shutdown with no active members       |
| 7   | Graceful shutdown requests member approval          |
| 8   | Member approves shutdown request                    |
| 9   | Member rejects shutdown with reason                 |
| 10  | Team shutdown fails with active members             |
| 11  | Team lead handles member going idle during shutdown |

### Key Behaviors

- Team configuration stored at `~/.openclaw/teams/{team_name}/config.json`
- Task list directory at `~/.openclaw/teams/{team_name}/ledger.db`
- Shutdown protocol requires member approval via `shutdown_request`/`shutdown_response`
- Team lead waits for all member responses before completing shutdown
- Teammate sessions spawn via `spawnSubagentDirect()` with `lane: "teammate"`

### Example Scenario

```gherkin
Scenario: Member approves shutdown request
  Given an active team "collaborative-team"
  And member "researcher-1" is active on the team
  When the team lead requests shutdown
  And member "researcher-1" receives the shutdown_request via mailbox
  And member "researcher-1" responds with shutdown_response approve: true
  Then member "researcher-1" terminates its session
  And the team lead receives the approval confirmation
  And the team config is updated to status: "shutdown"
```

## Feature 2: Task Management

### Scenarios: 17

| #   | Scenario Description                                 |
| --- | ---------------------------------------------------- |
| 1   | Add a single task to the team                        |
| 2   | Add a task with active form                          |
| 3   | Add task with metadata                               |
| 4   | List all tasks in the team                           |
| 5   | List only pending tasks                              |
| 6   | Claim an available task                              |
| 7   | Claim task updates active form                       |
| 8   | Attempt to claim already claimed task                |
| 9   | Atomic task claiming prevents race conditions        |
| 10  | Mark task as completed                               |
| 11  | Add task with dependencies                           |
| 12  | List tasks blocked by dependencies                   |
| 13  | Auto-unblock tasks when dependency completes         |
| 14  | Complex dependency chain resolution                  |
| 15  | Circular dependency detection and prevention         |
| 16  | Task completion removes from blockedBy of dependents |
| 17  | Query tasks by metadata filters                      |

### Key Behaviors

- Tasks have immutable: `id`, `subject`, `description`, `dependsOn`
- Tasks have mutable: `status`, `owner`, `activeForm`
- Atomic claiming uses SQL UPDATE with WHERE clause
- `dependsOn` defines dependencies, `blockedBy` is computed and updated on completion
- Circular dependencies detected during task creation

### Example Scenario

```gherkin
Scenario: Atomic task claiming prevents race conditions
  Given a pending task with ID 5
  And two idle members "agent-fast" and "agent-slow"
  When both members attempt to claim the task simultaneously
  Then only one member successfully claims the task
  And the other member receives a conflict error
  And the task has exactly one owner assigned
  And no partial ownership states exist
```

## Feature 3: Mailbox Communication

### Scenarios: 19

| #   | Scenario Description                                    |
| --- | ------------------------------------------------------- |
| 1   | Send direct message to teammate                         |
| 2   | Message delivery is automatic                           |
| 3   | Message delivered only to intended recipient            |
| 4   | Plain text output is NOT visible to teammates           |
| 5   | Broadcast message to all teammates                      |
| 6   | Broadcast delivers to all N teammates                   |
| 7   | Broadcast excludes sender                               |
| 8   | Send shutdown request to member                         |
| 9   | Shutdown response with approval                         |
| 10  | Shutdown response with rejection and reason             |
| 11  | Shutdown protocol includes request_id                   |
| 12  | Response matches request_id                             |
| 13  | Message summary provided for UI preview                 |
| 14  | Summary limited to 5-10 words                           |
| 15  | Idle notification sent to team lead                     |
| 16  | Team lead does not auto-respond to idle during shutdown |
| 17  | Peer DM visibility (summary only)                       |
| 18  | Message persists if recipient offline                   |
| 19  | Message queue processed on next inference               |

### Key Behaviors

- Messages stored in `~/.openclaw/teams/{team}/inbox/{session_key}/messages.jsonl`
- Messages injected into context with XML tags: `<teammate-message teammate_id="" type="">`
- Plain tool output is NOT shared - must use SendMessage for peer communication
- Shutdown protocol uses request/response pattern with unique IDs

### Example Scenario

```gherkin
Scenario: Peer-to-peer direct message
  Given a team "research-team" with members "researcher-1" and "researcher-2"
  And "researcher-1" is working on task "Analyze code"
  When "researcher-1" sends a direct message to "researcher-2"
  And the message content is "Please review the auth module"
  Then the message is written to researcher-2's inbox
  And "researcher-2" sees the message on next inference
  And the message is injected as XML context
```

## Feature 4: Concurrency Control

### Scenarios: 19

| #   | Scenario Description                               |
| --- | -------------------------------------------------- |
| 1   | WAL mode enables concurrent reads during writes    |
| 2   | Multiple readers access DB during single write     |
| 3   | Write operation blocks other writers               |
| 4   | Lock levels: SHARED, RESERVED, PENDING, EXCLUSIVE  |
| 5   | BEGIN CONCURRENT for optimistic concurrency        |
| 6   | CONCURRENT rollback on conflict                    |
| 7   | Checkpoint starvation prevention                   |
| 8   | Configurable WAL checkpoint threshold              |
| 9   | Atomic task claiming prevents race conditions      |
| 10  | UPDATE with WHERE returns row count                |
| 11  | Zero rows affected = task already claimed          |
| 12  | Transaction isolation level SERIALIZABLE for claim |
| 13  | Retry logic on SQLITE_BUSY error                   |
| 14  | Maximum retry attempts                             |
| 15  | Exponential backoff between retries                |
| 16  | Deadlock prevention with consistent ordering       |
| 17  | Transaction timeout                                |
| 18  | Connection pooling handles concurrent agents       |
| 19  | Connection reuse within same session               |

### Key Behaviors

- SQLite WAL mode: one writer, multiple readers
- Atomic claim: `UPDATE tasks SET owner=? WHERE id=? AND status='pending' AND owner IS NULL`
- SQLITE_BUSY handled with retry logic (max 5 attempts, exponential backoff)
- Checkpoint threshold prevents WAL file growth

### Example Scenario

```gherkin
Scenario: WAL mode enables concurrent reads
  Given a team with active SQLite ledger
  And a write transaction in progress
  When multiple teammates query pending tasks
  Then all read queries succeed without blocking
  And the write transaction completes successfully
  And no SQLITE_BUSY errors occur for readers
```

## Feature 5: Teammate Spawning

### Scenarios: 18

| #   | Scenario Description                    |
| --- | --------------------------------------- |
| 1   | Teammate spawns via spawnSubagentDirect |
| 2   | Teammate session uses teammate lane     |
| 3   | Teammate session key format is correct  |
| 4   | Teammate inherits sandbox settings      |
| 5   | Teammate registered in team config      |
| 6   | Teammate receives initial task prompt   |
| 7   | Teammate spawn with model override      |
| 8   | Teammate spawn with custom agent type   |
| 9   | Teammate spawn fails with invalid team  |
| 10  | Teammate depth tracking is correct      |
| 11  | Teammate can spawn sub-subagents        |
| 12  | Teammate subagent depth limits enforced |
| 13  | Teammate session persists after spawn   |
| 14  | Teammate mailbox inbox created          |
| 15  | Teammate receives team state injection  |
| 16  | Teammate announce flow on completion    |
| 17  | Teammate session cleanup on shutdown    |
| 18  | Multiple teammates spawn concurrently   |

### Key Behaviors

- Teammates spawn via `spawnSubagentDirect()` with `mode: "session"`
- Session key format: `agent:${agentId}:teammate:${uuid}`
- Lane: `AGENT_LANE_TEAMMATE`
- Completion announced via `runSubagentAnnounceFlow()`

### Example Scenario

```gherkin
Scenario: Teammate spawns via spawnSubagentDirect
  Given an active team "research-team" with team lead
  When team lead calls TeammateSpawn tool
  And parameters are { name: "researcher", agent_id: "default" }
  Then spawnSubagentDirect is called with lane: "teammate"
  And session key format is "agent:default:teammate:{uuid}"
  And the teammate is registered in team config
  And the teammate receives team state injection
```

## Implementation Checklist

### Phase 1: Core Infrastructure

- [ ] Create `src/teams/manager.ts` for SQLite operations
- [ ] Create `src/config/teams/store.ts` for team config persistence
- [ ] Define TypeScript types for teams, tasks, members, messages
- [ ] Implement WAL mode configuration
- [ ] Implement connection pooling
- [ ] Add `AGENT_LANE_TEAMMATE` to `src/agents/lanes.ts`

### Phase 2: Team Tools

- [ ] Implement `TeamCreate` tool
- [ ] Implement `TeammateSpawn` tool (wraps `spawnSubagentDirect`)
- [ ] Implement `TeamShutdown` tool
- [ ] Add team fields to SessionEntry type

### Phase 3: Task Tools

- [ ] Implement `TaskCreate` tool
- [ ] Implement `TaskList` tool
- [ ] Implement `TaskClaim` tool (atomic)
- [ ] Implement `TaskComplete` tool (with unblock logic)

### Phase 4: Communication Tools

- [ ] Implement `SendMessage` tool
- [ ] Implement inbox directory structure
- [ ] Implement message injection into context
- [ ] Implement shutdown protocol
- [ ] Integrate `runSubagentAnnounceFlow` for completion

### Phase 5: Testing

- [ ] Write unit tests for SQLite operations
- [ ] Write integration tests for tool interactions
- [ ] Write concurrency tests for race conditions
- [ ] Implement BDD step definitions for all 84 scenarios

## Appendix: Gherkin Step Definitions

### Team Lifecycle Steps

```typescript
Given("an active team {string}", async function (teamName: string) {
  const teamConfig = await createTeam({ name: teamName });
  this.team = teamConfig;
});

Given("member {string} is active on the team", async function (memberName: string) {
  const member = await spawnTeammate(this.team.name, { name: memberName });
  this.members.push(member);
});

When("the team lead requests shutdown", async function () {
  await sendShutdownRequest(this.team.name, this.teamLeadSession);
});
```

### Task Management Steps

```typescript
Given("a pending task with ID {string}", async function (taskId: string) {
  const task = await createTask(this.team.name, {
    id: taskId,
    subject: "Test task",
    description: "Test description",
    status: "pending",
  });
  this.task = task;
});

When("both members attempt to claim the task simultaneously", async function () {
  const [result1, result2] = await Promise.all([
    claimTask(this.team.name, this.members[0].sessionKey, this.task.id),
    claimTask(this.team.name, this.members[1].sessionKey, this.task.id),
  ]);
  this.claimResults = [result1, result2];
});
```

### Mailbox Steps

```typescript
When(
  "{string} sends a direct message to {string}",
  async function (fromName: string, toName: string) {
    const fromMember = this.members.find((m) => m.name === fromName);
    const toMember = this.members.find((m) => m.name === toName);
    await sendMessage(this.team.name, {
      from: fromMember.sessionKey,
      to: toMember.sessionKey,
      type: "message",
      content: this.messageContent,
    });
  },
);

Then("{string} sees the message on next inference", async function (memberName: string) {
  const member = this.members.find((m) => m.name === memberName);
  const context = await injectPendingMessages(member.sessionKey);
  expect(context).to.include(this.messageContent);
});
```

## References

- Full feature files: `/Users/FradSer/Developer/FradSer/openclaw/features/*.feature`
- Research summary: `/Users/FradSer/Developer/FradSer/openclaw/features/RESEARCH_SUMMARY.md`
- Feature index: `/Users/FradSer/Developer/FradSer/openclaw/features/FEATURE_INDEX.md`
