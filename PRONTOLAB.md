# Pronto-Lab OpenClaw Fork - Multi-Agent Features

> **Pronto-Lab Fork** of [OpenClaw](https://github.com/openclaw/openclaw)
>
> Custom features for 11 agents coordinating via Discord threads.

## Overview

This fork adds multi-agent coordination features for the Pronto-Lab team. Eleven AI agents collaborate through Discord threads with LLM-powered routing and coordinate work across shared tasks.

---

## Implemented Features

### 1. DM Retry (Discord DM Auto-Retry) ✅

**Purpose:** When Agent A sends a DM to Agent B and gets no response within the timeout period, the system automatically retries the message.

**Configuration:**

```json5
{
  channels: {
    discord: {
      dm: {
        retry: {
          enabled: true,
          timeoutMs: 300000, // 5 minutes
          maxAttempts: 3,
          backoffMs: 60000, // 1 minute between retries
          notifyOnFailure: true,
        },
      },
    },
  },
}
```

**Files:**
| File | Purpose |
|------|---------|
| `src/discord/dm-retry/tracker.ts` | Persistence layer for tracked DMs |
| `src/discord/dm-retry/utils.ts` | Config resolution helpers |
| `src/discord/dm-retry/scheduler.ts` | 60-second interval retry processor |
| `src/discord/dm-retry/index.ts` | Module exports |
| `src/config/types.discord.ts` | `DmRetryConfig` type definition |

**How it works:**

1. When an agent sends a DM, it's tracked in `dm-retry-tracking.json`
2. Every 60 seconds, the scheduler checks for timed-out pending DMs
3. Timed-out DMs are resent with a `[Retry N]` prefix
4. After max attempts, the DM is marked as failed

---

### 2. Task Continuation ✅

**Purpose:** Resume agents with pending work when the gateway restarts.

**Files:**
| File | Purpose |
|------|---------|
| `src/infra/task-continuation.ts` | Parse CURRENT_TASK.md and send resume messages |

**How it works:**

1. On gateway startup, scans each agent's workspace for `CURRENT_TASK.md`
2. Parses the `## Current` section for pending tasks
3. Sends a resume message to each agent with pending work
4. Includes task details, context, next steps, and progress

**CURRENT_TASK.md Format:**

```markdown
# Current Task

## Current

**Task:** Implement feature X
**Thread ID:** 12345
**Context:** User requested new button
**Next:** Add CSS styling
**Progress:**

- [x] Create component
- [ ] Add tests

---
```

---

### 3. Automatic Task Tracking ✅

**Purpose:** Automatically update `CURRENT_TASK.md` when an agent starts or finishes processing a message.

**Files:**
| File | Purpose |
|------|---------|
| `src/infra/task-tracker.ts` | Lifecycle event subscriber |
| `src/auto-reply/reply/agent-runner-execution.ts` | Integration: `registerTaskContext()` call |
| `src/commands/agent.ts` | Integration: `registerTaskContext()` call |
| `src/gateway/server-startup.ts` | Start task tracker on gateway startup |

**How it works:**

1. When agent processing starts, `registerTaskContext()` is called with the message body
2. On `lifecycle:start` event, writes task to `CURRENT_TASK.md`
3. On `lifecycle:end` or `lifecycle:error`, clears the task
4. If gateway crashes mid-task, `CURRENT_TASK.md` remains → Task Continuation picks it up on restart

---

### 4. Gateway Restart Notification ✅

**Purpose:** When an agent requests a gateway restart (e.g., "재시작해줘"), notify that agent after the restart completes so it can inform the user.

**Files:**
| File | Purpose |
|------|---------|
| `src/infra/restart-sentinel.ts` | Sentinel file with `requestingAgentId` field |
| `src/agents/tools/gateway-tool.ts` | Stores requesting agent ID when restart requested |
| `src/gateway/server-restart-sentinel.ts` | Post-restart notification logic |

**How it works:**

1. User tells agent: "Gateway 재시작해줘"
2. Agent calls `gateway({ action: "restart" })`
3. `requestingAgentId` is stored in `restart-sentinel.json`
4. Gateway restarts (SIGUSR1)
5. New gateway reads sentinel, sends message to requesting agent
6. Agent notifies user via Discord channel

**Flow:**

```
User → 루다: "재시작해줘"
     → 루다 calls gateway({ action: "restart" })
     → restart-sentinel.json { requestingAgentId: "main" }
     → Gateway restarts
     → notifyRequestingAgent("main")
     → 루다: "Gateway 재시작 완료됐어..."
     → 루다 → User (via 🌙-루다-dm channel)
```

---

### 6. Task Management MCP Tools ✅

**Purpose:** Agent-managed task tracking with 9 MCP tools for explicit task lifecycle control.

**Tools:**

| Tool            | Description                                          |
| --------------- | ---------------------------------------------------- |
| `task_start`    | Start a new task, creates file in `tasks/` directory |
| `task_update`   | Add progress entry to a task                         |
| `task_complete` | Mark task complete, archive to `TASK_HISTORY.md`     |
| `task_status`   | Get task status (specific or summary)                |
| `task_list`     | List all tasks with optional status filter           |
| `task_cancel`   | Cancel a task with optional reason                   |
| `task_approve`  | Approve a pending_approval task                      |
| `task_block`    | Block task until another agent helps (see §9)        |
| `task_resume`   | Resume a blocked task                                |

**Files:**

| File                            | Purpose                        |
| ------------------------------- | ------------------------------ |
| `src/agents/tools/task-tool.ts` | 9 MCP tool implementations     |
| `src/agents/openclaw-tools.ts`  | Tool registration              |
| `src/agents/tool-policy.ts`     | `group:task` policy group      |
| `src/infra/task-tracker.ts`     | Agent-managed mode integration |
| `src/plugins/runtime/index.ts`  | Plugin SDK exports             |

**How it works:**

1. Agent calls `task_start` → creates `tasks/task_xxx.md` file
2. Agent calls `task_update` → adds progress entries
3. Agent calls `task_complete` → archives to `TASK_HISTORY.md`, deletes task file
4. When agent uses task tools, automatic CURRENT_TASK.md clearing is disabled (agent-managed mode)

**Task File Format (`tasks/task_xxx.md`):**

```markdown
# Task: task_m1abc_xyz1

## Metadata

- **Status:** in_progress
- **Priority:** high
- **Created:** 2026-02-04T12:00:00.000Z

## Description

Implement new feature X

## Context

User requested via Discord

## Progress

- Task started
- Created initial component
- Added unit tests

## Last Activity

2026-02-04T12:30:00.000Z

---

_Managed by task tools_
```

**Multi-task Support:**

- Multiple tasks can exist simultaneously in `tasks/` directory
- Tasks are sorted by priority (urgent > high > medium > low) then creation time
- `task_list` shows all tasks with filtering by status

**Real-time Monitoring:**

```bash
# Watch all agents' tasks in real-time (CLI)
scripts/task-watch.sh

# Watch specific agent
scripts/task-watch.sh eden

# Check current status once
cat ~/.openclaw/agents/main/CURRENT_TASK.md
ls ~/.openclaw/agents/*/tasks/
```

---

### 7. Task Monitor API Server ✅

**Purpose:** Standalone HTTP + WebSocket server for real-time task monitoring via web interface.

**Files:**

| File                                    | Purpose                   |
| --------------------------------------- | ------------------------- |
| `scripts/task-monitor-server.ts`        | API server implementation |
| `src/task-monitor/task-monitor.test.ts` | Unit tests                |

**Usage:**

```bash
# Start server (default port 3847)
bun scripts/task-monitor-server.ts

# Custom port
bun scripts/task-monitor-server.ts --port 8080

# Environment variable
TASK_MONITOR_PORT=8080 bun scripts/task-monitor-server.ts
```

**API Endpoints:**

| Endpoint                      | Description                      |
| ----------------------------- | -------------------------------- |
| `GET /api/health`             | Health check                     |
| `GET /api/agents`             | List all agents with task counts |
| `GET /api/agents/:id/info`    | Agent details                    |
| `GET /api/agents/:id/tasks`   | List tasks (optional `?status=`) |
| `GET /api/agents/:id/current` | Current task status              |
| `GET /api/agents/:id/history` | Task history                     |
| `GET /api/agents/:id/blocked` | Blocked tasks with metadata      |

**WebSocket:**

```javascript
const ws = new WebSocket("ws://localhost:3847/ws");

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  // msg.type: "connected" | "agent_update" | "task_update"
  // msg.agentId: agent ID
  // msg.taskId: task ID (for task_update)
  // msg.timestamp: ISO timestamp
  console.log(msg);
};
```

**Response Examples:**

```json
// GET /api/agents
{
  "agents": [
    { "id": "main", "workspaceDir": "...", "hasCurrentTask": true, "taskCount": 2 },
    { "id": "eden", "workspaceDir": "...", "hasCurrentTask": false, "taskCount": 0 }
  ],
  "count": 2
}

// GET /api/agents/main/current
{
  "agentId": "main",
  "hasTask": true,
  "content": "...",
  "taskSummary": "Implementing feature X"
}

// WebSocket message
{
  "type": "task_update",
  "agentId": "main",
  "taskId": "task_abc123",
  "timestamp": "2026-02-04T12:30:00.000Z",
  "data": { "event": "change", "file": "task_abc123.md" }
}
```

---

### 8. Skill System (Phase 1) ✅

**Purpose:** Define domain-specific workflows and behaviors that can be injected into agent/subagent prompts.

**Files:**
| File | Purpose |
|------|---------|
| `~/.openclaw/skills/delegate/SKILL.md` | Category→model mapping + workflow skills |
| `~/.openclaw/SKILL-GOVERNANCE.md` | Skill creation governance and KPIs |

**Implemented Workflow Skills:**

| Skill                | Agent     | Purpose                           |
| -------------------- | --------- | --------------------------------- |
| `dev-tdd`            | 이든 💻   | TDD workflow (RED-GREEN-REFACTOR) |
| `git-commit`         | 이든/세움 | Conventional Commits convention   |
| `infra-troubleshoot` | 세움 🔧   | Incident response workflow        |

**How it works:**

1. Skills are defined in `<Workflow_Context>` blocks with English instructions
2. Each skill has: 적용 시점, 프롬프트 예시, 성공 지표
3. Skills are injected into subagent prompts via `sessions_spawn`
4. Governance document tracks KPIs and skill lifecycle

**Future Proposals:**

- Skill Groups + Lazy Loading (reduce context bloat)
- Per-agent default skill groups
- Task-aware skill selection

See:

- Proposal: `/Users/server/openclaw-future/PROPOSAL-skill-groups-impl.md`
- Governance: `~/.openclaw/SKILL-GOVERNANCE.md`

---

### 9. Agent Collaboration v2 (Thread-based) ✅

**Purpose:** Replace DM-based agent-to-agent communication with visible Discord thread-based collaboration using LLM-powered channel/thread routing.

**Key Components:**
| Component | File | Purpose |
|-----------|------|---------|
| Collaborate Tool | `src/agents/tools/collaborate-tool.ts` | `collaborate` MCP tool for peer-to-peer agent collaboration |
| ChannelRouter | `src/infra/events/sinks/channel-router.ts` | LLM-powered channel/thread selection |
| Handler/Observer | `src/discord/monitor/message-handler.preflight.ts` | Smart thread participation routing |
| Thread Participants | `src/discord/monitor/thread-participants.ts` | Thread participant registry (24h TTL) |
| Sibling Bots | `src/discord/monitor/sibling-bots.ts` | Bot user ID ↔ agent ID mapping |

**How it works:**

1. Agent A calls `collaborate(targetAgent: "eden", message: "...")`
2. ChannelRouter (LLM) selects appropriate channel and thread
3. Thread created/reused with Agent A's bot identity
4. Message sent with @target mention
5. Target agent's monitor → Handler path (responds via LLM)
6. Sender agent's monitor → Observer path (records to history)

**Architecture doc:** `custom-docs/AGENT-COLLABORATION-V2.md`

---

### 10. Handler/Observer Pattern ✅

**Purpose:** When multiple agents are in a Discord thread, only the @mentioned agent responds (Handler), while other participant agents silently observe (Observer) to maintain context.

**How it works:**

1. Message arrives in Discord thread
2. Preflight check determines if bot is mentioned → HANDLER
3. If not mentioned but is thread participant → OBSERVER
4. Handler: full LLM processing, generates response
5. Observer: message recorded to session history, no LLM call

**Files:**
| File | Purpose |
|------|---------|
| `src/discord/monitor/message-handler.preflight.ts` | Handler vs Observer routing logic |
| `src/discord/monitor/message-handler.process.ts` | A2A thread routing and processing |
| `src/discord/monitor/thread-participants.ts` | ThreadParticipantMap (globalThis singleton, disk persistence) |

---

### 11. ChannelRouter (LLM-powered Routing) ✅

**Purpose:** Use Claude as a sub-agent to intelligently route agent conversations to appropriate Discord channels and threads based on topic analysis.

**How it works:**

1. Collaborate tool calls `routeViaLLM()` with agent context
2. ChannelRouter lists guild channels and active threads
3. Claude analyzes message topic and matches to best channel/thread
4. Returns: channelId, threadId (if existing), threadName (if new)
5. ThreadRouteCache caches decisions for conversation pairs

**Configuration (in gateway.conversationSinks):**

```json5
{
  gateway: {
    conversationSinks: [
      {
        id: "discord-conversation",
        type: "discord-conversation",
        options: {
          guildId: "...",
          defaultChannelId: "...",
          routerAccountId: "ruda",
          routerModel: "claude-sonnet-4-20250514",
        },
      },
    ],
  },
}
```

---

## Agent Configuration

| Agent ID         | Name        | Emoji | Role              |
| ---------------- | ----------- | ----- | ----------------- |
| `main` (default) | 루다 (Luda) | 🌙    | Main coordinator  |
| `eden`           | 이든        | 💻    | Developer         |
| `seum`           | 세움        | 🔧    | Builder           |
| `yunseul`        | 윤슬        | ✨    | Creative          |
| `miri`           | 미리        | 📊    | Analyst           |
| `onsae`          | 온새        | 🌿    | Nature            |
| `ieum`           | 이음        | 🔗    | Connector         |
| `dajim`          | 다짐        | 💪    | Commitment        |
| `nuri`           | 누리        | 🌍    | World/Community   |
| `hangyeol`       | 한결        | 🎯    | Consistency       |
| `grim`           | 그림        | 🎨    | Art/Visualization |

**Utility Agents:**

| Agent ID       | Name         | Emoji | Role                |
| -------------- | ------------ | ----- | ------------------- |
| `explorer`     | Explorer     |       | Exploration         |
| `worker-quick` | Worker-Quick |       | Fast task execution |
| `worker-deep`  | Worker-Deep  |       | Deep task execution |
| `consultant`   | Consultant   |       | Consulting          |

---

## Commands

### Build and Link

```bash
cd /Users/server/prontolab-openclaw
pnpm build && npm link
```

### Restart Gateway

```bash
pkill -9 -f "openclaw.*gateway"
nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
```

### Watch Logs

```bash
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log
```

### Check Gateway Status

```bash
pgrep -f "openclaw.*gateway"
```

### Send Message to Agent

```bash
openclaw agent --agent main --message "안녕하세요"
```

### Test Restart Notification

```bash
openclaw agent --agent main --message "gateway tool로 재시작해줘"
```

---

## Git Information

| Item         | Value                                            |
| ------------ | ------------------------------------------------ |
| **Upstream** | https://github.com/openclaw/openclaw             |
| **Fork**     | https://github.com/Pronto-Lab/prontolab-openclaw |
| **Branch**   | `main`                                           |

### Recent Commits

```
373fef522 feat(tools): add task management MCP tools
c87eaa39c fix(boot-md): clarify system prompt to prevent injection false positives
6b647ce13 feat(gateway): notify requesting agent after restart completes
25dbe720e feat(infra): add automatic task tracking for CURRENT_TASK.md
f84b16ff2 feat(discord): add DM retry and task continuation for multi-agent
```

---

## Key Files Reference

| Purpose                    | File                                               |
| -------------------------- | -------------------------------------------------- |
| Restart sentinel types     | `src/infra/restart-sentinel.ts`                    |
| Gateway restart wake       | `src/gateway/server-restart-sentinel.ts`           |
| Gateway tool               | `src/agents/tools/gateway-tool.ts`                 |
| Session key utils          | `src/routing/session-key.js`                       |
| Task tracker               | `src/infra/task-tracker.ts`                        |
| Task continuation          | `src/infra/task-continuation.ts`                   |
| Task MCP tools             | `src/agents/tools/task-tool.ts`                    |
| Task watch script          | `scripts/task-watch.sh`                            |
| DM retry scheduler         | `src/discord/dm-retry/scheduler.ts`                |
| DM retry tracker           | `src/discord/dm-retry/tracker.ts`                  |
| Gateway startup            | `src/gateway/server-startup.ts`                    |
| Collaborate tool           | `src/agents/tools/collaborate-tool.ts`             |
| ChannelRouter              | `src/infra/events/sinks/channel-router.ts`         |
| Thread participants        | `src/discord/monitor/thread-participants.ts`       |
| Sibling bots registry      | `src/discord/monitor/sibling-bots.ts`              |
| Handler/Observer preflight | `src/discord/monitor/message-handler.preflight.ts` |
| System prompt              | `src/agents/system-prompt.ts`                      |
| Tool policy                | `src/agents/tool-policy.ts`                        |

---

## Testing

Run all tests:

```bash
pnpm test
```

Run specific test file:

```bash
pnpm test src/discord/dm-retry/tracker.test.ts
pnpm test src/infra/task-tracker.test.ts
pnpm test src/infra/task-continuation.test.ts
pnpm test src/gateway/server-restart-sentinel.test.ts
```

---

## Upstream Sync (Intent-Preserving, Anti-Skew)

**Goal:** merge upstream changes without breaking ProntoLab behavior.

### 1) Prepare sync branch

```bash
git fetch upstream --tags
git checkout sync-upstream-v2026.2.15
```

### 2) Merge upstream tag (not main head)

```bash
git merge --no-ff v2026.2.15
```

### 3) Conflict policy (ProntoLab-first)

- Keep ProntoLab intent first for runtime-critical paths (`src/gateway/*`, `src/discord/monitor/*`, `src/infra/task-*`, `src/agents/tools/*`).
- Pull upstream changes only when they do not alter ProntoLab operational semantics.
- Avoid mixed-version clusters (HEAD tests + MERGE_HEAD helpers, or vice versa).

### 4) Version-skew audit (required)

Run this after conflict resolution to detect mixed file families:

```bash
# compare current blob with HEAD and MERGE_HEAD for key clusters
for f in \
  src/test-utils/channel-plugins.ts \
  src/infra/outbound/message-action-runner.ts \
  src/infra/outbound/targets.ts \
  src/discord/send.ts \
  src/auto-reply/reply/get-reply-run.ts \
  src/agents/subagent-announce-queue.ts
do
  cur=$(git hash-object "$f")
  h=$(git rev-parse "HEAD:$f" 2>/dev/null || true)
  m=$(git rev-parse "MERGE_HEAD:$f" 2>/dev/null || true)
  [ "$cur" = "$h" ] && ah=true || ah=false
  [ "$cur" = "$m" ] && am=true || am=false
  echo "$f,AT_HEAD=$ah,AT_MERGE_HEAD=$am"
done
```

**Rule:** for a failing cluster, align related implementation+tests+helpers to one side (usually HEAD/ProntoLab) instead of partial mixing.

### 5) Validation gate (required)

```bash
pnpm build
pnpm test:fast
```

Do not finalize sync if either command fails.

---

## Development Setup

```bash
cd /Users/server/prontolab-openclaw
pnpm install
pnpm build
npm link  # Use this build instead of global npm install
```

---

## Contributing Back to Upstream

If a feature is generally useful, consider submitting a PR to upstream:

1. Create clean feature branch from `main`
2. Implement with minimal changes
3. Add tests and docs
4. Submit PR to `openclaw/openclaw`

---

## Notes

- Korean language is used in agent messages (Korean team/users)
- `commands.restart: true` must be set in `~/.openclaw/openclaw.json` for restart command
- All features are designed to work with the existing OpenClaw infrastructure

---

---

### 9. Task Blocking System (Agent-to-Agent Coordination) ✅

**Purpose:** Allow agents to block on tasks that require another agent's help, with automatic unblock request system.

**Tools:**

| Tool          | Description                                         |
| ------------- | --------------------------------------------------- |
| `task_block`  | Block current task, specify who can unblock and why |
| `task_resume` | Resume a blocked task (used by unblocking agent)    |

**Files:**

| File                                    | Purpose                                |
| --------------------------------------- | -------------------------------------- |
| `src/agents/tools/task-tool.ts`         | task_block/task_resume implementations |
| `src/infra/task-continuation-runner.ts` | Automatic unblock request scheduler    |
| `src/infra/task-lock.ts`                | File-based locking for task operations |
| `src/agents/tool-policy.ts`             | group:task includes block/resume tools |

**How it works:**

1. Agent A calls `task_block({ reason: "Need code review", unblock_by: ["eden"], unblock_action: "Review PR #123" })`
2. Task status changes to `blocked`, blocking metadata saved in `## Blocking` section as JSON
3. Task continuation runner periodically checks blocked tasks
4. Sends unblock request to next agent in `unblock_by` list (round-robin)
5. After 3 failed attempts, sets `escalationState: "failed"`
6. Unblocking agent can call `task_resume()` to resume the task

**Task File Format (Blocked Task):**

```markdown
# Task: task_m1abc_xyz1

## Metadata

- **Status:** blocked
- **Priority:** high
- **Created:** 2026-02-06T10:00:00.000Z

## Description

Implement new feature X

## Progress

- Task started
- [BLOCKED] Need code review from eden
- [UNBLOCK REQUEST 1/3] Sent to eden

## Last Activity

2026-02-06T10:30:00.000Z

## Blocking

\`\`\`json
{"blockedReason":"Need code review from eden","unblockedBy":["eden"],"unblockedAction":"Review PR #123","unblockRequestCount":1,"lastUnblockerIndex":0,"escalationState":"requesting"}
\`\`\`

---

_Managed by task tools_
```

**Blocking Fields:**

| Field                    | Type     | Description                                 |
| ------------------------ | -------- | ------------------------------------------- | ------------ | ----------- | -------- |
| `blockedReason`          | string   | Why the task is blocked                     |
| `unblockedBy`            | string[] | Agent IDs who can help unblock              |
| `unblockedAction`        | string?  | What the unblocking agent should do         |
| `unblockRequestCount`    | number   | How many unblock requests have been sent    |
| `lastUnblockerIndex`     | number   | Index in unblockedBy for round-robin        |
| `lastUnblockRequestAt`   | string   | ISO timestamp of last request               |
| `escalationState`        | string   | "none"                                      | "requesting" | "escalated" | "failed" |
| `unblockRequestFailures` | number   | Count of consecutive agent command failures |

**Automatic Unblock Requests:**

- Task continuation runner checks blocked tasks every interval
- Sends unblock request to agents in `unblock_by` list using round-robin
- Maximum 3 requests per agent before escalation
- Failed agent commands increment `unblockRequestFailures`
- After 3 consecutive failures, escalation state becomes "failed"

**API Endpoints for Blocked Tasks:**

| Endpoint                      | Description                          |
| ----------------------------- | ------------------------------------ |
| `GET /api/agents/:id/blocked` | Get blocked tasks with full metadata |

**Example Response:**

```json
{
  "agentId": "main",
  "blockedTasks": [
    {
      "id": "task_m1abc_xyz1",
      "description": "Implement new feature X",
      "blockedReason": "Need code review from eden",
      "unblockedBy": ["eden"],
      "unblockedAction": "Review PR #123",
      "unblockRequestCount": 1,
      "escalationState": "requesting",
      "lastUnblockerIndex": 0,
      "lastUnblockRequestAt": "2026-02-06T10:30:00.000Z",
      "unblockRequestFailures": 0,
      "lastActivity": "2026-02-06T10:30:00.000Z"
    }
  ],
  "count": 1
}
```

**Validation:**

- Cannot block on yourself (self-reference check)
- Agent IDs must exist in system
- `unblock_by` must be non-empty array
- Only blocked tasks can be resumed

---

---

### 10. EventBus → Discord Monitoring Pipe ✅

**Purpose:** Forward task coordination events to a Discord webhook for real-time operational monitoring.

**Files:**
| File | Purpose |
|------|---------|
| `src/infra/events/discord-sink.ts` | Batched event → Discord embed forwarder |
| `src/infra/events/discord-sink.test.ts` | 4 tests |

**Features:**

- Batched delivery (configurable window, default 5s)
- Color-coded embeds per event type (green=started, blue=completed, red=blocked, etc.)
- Event type filter (forward only selected events)
- Max batch size with force-flush
- Rate limit handling with retry-after
- Graceful stop with final flush

---

### 11. Sibling Bot Bypass ✅

**Purpose:** In multi-agent deployments, agents should not be filtered by the standard bot-drop rule. Sibling bots are auto-registered and bypass the filter.

**Files:**
| File | Purpose |
|------|---------|
| `src/discord/monitor/sibling-bots.ts` | Bot ID registry |
| `src/discord/monitor/sibling-bots.test.ts` | 5 tests |
| `src/discord/monitor/message-handler.preflight.ts` | Bypass integration |
| `src/discord/monitor/provider.ts` | Auto-register on login |

---

### 12. Session-Aware Browser Isolation ✅

**Purpose:** Prevent browser role-ref cache collisions between agents sharing the same browser.

**Files:**
| File | Purpose |
|------|---------|
| `src/browser/pw-session.ts` | Session-scoped `roleRefsByTarget` caches |

**Changes:**

- Global `roleRefsByTarget` Map → per-session Map registry
- `getSessionRoleRefCache(sessionKey)` helper
- `clearSessionRoleRefs(sessionKey)` cleanup function
- All role ref functions accept optional `sessionKey` parameter

---

### 13. TaskOutcome Type ✅

**Purpose:** Structured terminal state recording for tasks (completed, cancelled, error, interrupted).

**Files:**
| File | Purpose |
|------|---------|
| `src/agents/tools/task-tool.ts` | `TaskOutcome` union type + serialization |
| `src/infra/task-continuation-runner.ts` | Outcome set on zombie→interrupted |

**Type:**

```typescript
type TaskOutcome =
  | { kind: "completed"; summary?: string }
  | { kind: "cancelled"; reason?: string; by?: string }
  | { kind: "error"; error: string; retriable?: boolean }
  | { kind: "interrupted"; by?: string; reason?: string };
```

---

### 14. Plan Approval Flow ✅

**Purpose:** Worker agents submit execution plans for lead agent approval before proceeding.

**Files:**
| File | Purpose |
|------|---------|
| `src/infra/plan-approval.ts` | Plan CRUD + file persistence |
| `src/infra/plan-approval.test.ts` | 7 tests |
| `src/infra/events/schemas.ts` | `PLAN_SUBMITTED`, `PLAN_APPROVED`, `PLAN_REJECTED` events |

**Flow:**

1. Worker: `submitPlan()` → status "pending"
2. Lead: `approvePlan()` → status "approved" (or `rejectPlan()` → "rejected")
3. Worker: checks `getPlan().status` before proceeding

---

### 15. Session Tool Gate ✅

**Purpose:** Per-session runtime tool permission gating for least-privilege execution.

**Files:**
| File | Purpose |
|------|---------|
| `src/agents/session-tool-gate.ts` | Gate/approve/revoke/query primitives |
| `src/agents/session-tool-gate.test.ts` | 8 tests |

**API:**

- `gateSessionTools(sessionKey, ["exec", "write"])` — block tools
- `approveSessionTools(sessionKey, ["exec"])` — unblock specific tools
- `isToolGated(sessionKey, "exec")` — check if blocked

---

### 16. Agent-to-Agent Loop Prevention ✅

**Purpose:** Detect and prevent infinite message loops between agents.

**Files:**
| File | Purpose |
|------|---------|
| `src/discord/loop-guard.ts` | Self-message filter + rate guard + depth cap |
| `src/discord/loop-guard.test.ts` | 12 tests |

**Guards:**

1. **Self-message filter**: Blocks messages where author's applicationId matches our own
2. **Rate guard**: Sliding-window rate limiter per A2A channel pair (default: 10 msgs/60s)
3. **Depth cap**: Maximum A2A relay depth (default: 5)

---

### 17. Team State → Discord Dashboard ✅

**Purpose:** Periodic live dashboard embed showing all agent statuses.

**Files:**
| File | Purpose |
|------|---------|
| `src/infra/team-dashboard.ts` | Periodic embed poster/editor |
| `src/infra/team-dashboard.test.ts` | 4 tests |

**Features:**

- Posts initial embed, then edits same message on subsequent ticks
- Status emoji per agent (🟢 active, 🟡 idle, 🔴 blocked/interrupted)
- Shows current task, last activity time, failure reasons
- Configurable refresh interval (default: 30s)

---

### 18. History Include Bots ✅

**Purpose:** Record bot (sibling agent) messages to guild history for multi-agent context visibility.

**Files:**
| File | Purpose |
|------|---------|
| `src/config/types.discord.ts` | `historyIncludeBots?: boolean` field |
| `src/config/zod-schema.providers-core.ts` | Schema validation |
| `src/discord/monitor/message-handler.preflight.ts` | History recording before bot drop |

**Configuration:**

```json5
{
  channels: {
    discord: {
      historyIncludeBots: true, // Record sibling bot messages to history
    },
  },
}
```

---

### 19. Preserve AccountId in A2A Messaging ✅

**Purpose:** Maintain correct accountId fallback chain when relaying messages between agents.

**Files:**
| File | Purpose |
|------|---------|
| `src/infra/outbound/agent-delivery.ts` | Added `baseDelivery.lastAccountId` fallback |

---

### 20. Sisyphus Sub-Agent Orchestration ✅

**Status:** 핵심 구조 반영 완료 및 운영 중 (sub-agent 전용 workspace/AGENTS.md + `allowAgents` + sub-agent task/milestone 도구 차단).

**Purpose:** oh-my-opencode의 Sisyphus 패턴을 prontolab-openclaw 에이전트에 적용하여, 부모 에이전트가 전문 서브에이전트를 spawn하여 작업을 위임하는 orchestration 체계 도입.

**핵심 메커니즘:** `sessions_spawn(agentId: "explorer")` → `~/.openclaw/workspace-explorer/AGENTS.md`가 로드됨. 서브에이전트를 별도 에이전트로 등록하여 각 서브에이전트가 자기만의 전문성 AGENTS.md를 갖게 한다.

**서브에이전트 4종:**

| 서브에이전트 | agentId        | 모델      | 역할           | timeout |
| ------------ | -------------- | --------- | -------------- | ------- |
| Explorer     | `explorer`     | codex-5.3 | 읽기 전용 탐색 | 120s    |
| Worker-Quick | `worker-quick` | codex-5.3 | 단순 수정      | 60s     |
| Worker-Deep  | `worker-deep`  | codex-5.3 | 복잡한 구현    | 600s    |
| Consultant   | `consultant`   | codex-5.3 | 아키텍처 상담  | 900s    |

**변경 요약:**

| As-Is                                  | To-Be                         |
| -------------------------------------- | ----------------------------- |
| sub-agent workspace = 부모와 동일      | 서브에이전트별 독립 workspace |
| sub-agent가 부모의 전체 AGENTS.md 받음 | 서브에이전트별 전용 AGENTS.md |
| 카테고리 주입 = task 텍스트에 의존     | agentId로 서브에이전트 선택   |
| Orchestration 지침 없음                | 부모 AGENTS.md에만 삽입       |
| task 도구 = sub-agent도 사용 가능      | sub-agent에서 차단            |

**상세 설계 문서:** [`custom-docs/`](./custom-docs/) 디렉토리 참조

| 문서                                                                         | 내용                                                                 |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [custom-docs/SISYPHUS-DESIGN.md](./custom-docs/SISYPHUS-DESIGN.md)           | 전체 설계 (배경, As-Is/To-Be, 서브에이전트 정의, Orchestration 패턴) |
| [custom-docs/IMPLEMENTATION-GUIDE.md](./custom-docs/IMPLEMENTATION-GUIDE.md) | 단계별 구현 가이드 (Phase 1-4)                                       |
| [custom-docs/REFERENCES.md](./custom-docs/REFERENCES.md)                     | 소스 코드 참조, 설정 스냅샷                                          |

**운영 반영 근거:**

- `~/.openclaw/openclaw.json` — `agents.list`에 `explorer`/`worker-quick`/`worker-deep`/`consultant` 등록
- `~/.openclaw/openclaw.json` — 부모 에이전트 `subagents.allowAgents` 적용
- `~/.openclaw/openclaw.json` — `tools.subagents.tools.deny`에 task/milestone 도구 차단
- `~/.openclaw/workspace-{agentId}/AGENTS.md` — 서브에이전트 전용 지침 분리

---

### 21. Task Steps + Self-Driving + Stop Guard ✅ (핵심 로직 구현)

**Status:** Gateway + Task Monitor 핵심 로직 구현 완료. Task Hub UI/UX 연동은 별도 저장소/트랙에서 확장.

**Purpose:** 에이전트가 작업을 끝까지 완료하도록 강제하는 Sisyphus 동등 메커니즘. 5-Layer Safety Net으로 에이전트의 조기 종료를 원천 차단.

**Sisyphus 동등성:**

| Sisyphus 메커니즘          | prontolab 구현                 | 동등? |
| -------------------------- | ------------------------------ | ----- |
| todowrite 체크리스트       | TaskStep[]                     | ✅    |
| todo-continuation-enforcer | Event-Based Continuation (2초) | ✅    |
| Ralph Loop                 | Self-Driving Loop (0.5초)      | ✅    |
| Stop Guard                 | task_complete 차단             | ✅    |
| Boulder (영속 상태)        | TaskFile 파일 기반             | ✅    |

**5-Layer Safety Net:**

| Layer | 메커니즘                    | 지연  | 역할                                      |
| ----- | --------------------------- | ----- | ----------------------------------------- |
| 0     | AGENTS.md 지침              | —     | 에이전트 자발적 협조                      |
| 1     | Stop Guard                  | 0ms   | task_complete + 미완료 steps → ❌ 차단    |
| 2     | Self-Driving Loop           | 0.5초 | lifecycle:end → 즉시 재시작 (강한 prompt) |
| 3     | Event-Based Continuation    | 2초   | Self-Driving 실패 시 fallback             |
| 4     | Polling Continuation (기존) | ~5분  | 최후의 안전망                             |

**구현 근거 파일 (현재 리포):**

- `src/agents/tools/task-tool.ts` — `TaskStep` + step action + Stop Guard
- `src/infra/task-self-driving.ts` — Self-Driving Loop
- `src/infra/task-step-continuation.ts` — Event-Based Continuation fallback
- `src/gateway/server.impl.ts` — 런타임 wiring
- `scripts/task-monitor-server.ts` — step 파싱/응답 확장

**연동 상태:**

- Gateway: 구현 완료
- Task Monitoring Server: 구현 완료
- Task Hub: 별도 저장소 연동 항목 (확장 트랙)

**상세 설계 문서:** [custom-docs/TASK-STEPS-DESIGN.md](./custom-docs/TASK-STEPS-DESIGN.md)

---

### 22. Harness-Aware Agent Execution ✅

**Purpose:** Harness 스펙(steps + verificationChecklist) 준수를 시스템적으로 추적. 에이전트가 step/check를 보고하면 Task Hub에서 자동 verification 관리.

**Tools:**

| Tool                   | Description                                       |
| ---------------------- | ------------------------------------------------- |
| `harness_report_step`  | 스펙 step 완료/스킵 보고                          |
| `harness_report_check` | 검증 체크리스트 항목 결과 보고 (자동 passed 전환) |

**Files:**

| File                                    | Purpose                             |
| --------------------------------------- | ----------------------------------- |
| `src/agents/tools/harness-tool.ts`      | 도구 구현                           |
| `src/agents/openclaw-tools.ts`          | 도구 등록                           |
| `src/agents/tools/task-file-io.ts`      | TaskFile에 harness 필드 추가        |
| `src/agents/tools/task-blocking.ts`     | task_backlog_add 스키마 확장        |
| `src/infra/task-continuation-runner.ts` | harness protocol 프롬프트 자동 주입 |

**How it works:**

1. Task Hub Launch → `delegateToAgent()`에 `harnessProjectSlug`, `harnessItemId` 전달
2. Gateway `task_backlog_add` → TaskFile에 harness 필드 직렬화
3. `task-continuation-runner`가 pickup prompt에 harness protocol 자동 주입
4. 에이전트가 `harness_report_step/check` 호출 → Task Hub Verify API
5. 전체 checks 통과 시 `verification.status = "passed"` 자동 전환

**상세 설계 문서:** [custom-docs/HARNESS-EXECUTION-DESIGN.md](./custom-docs/HARNESS-EXECUTION-DESIGN.md)

---

## Upstream Merge History

| Date       | Version    | Commit      | Notes                                                                                                                                           |
| ---------- | ---------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-02-13 | v2026.2.12 | `375a30a52` | 5개 충돌 해결 (package.json, pnpm-lock.yaml, google.ts, model.ts, schema.ts). voice 패키지 유지, fork config UI 코드 유지, signature 패치 적용. |

---

_Last updated: 2026-02-17_
