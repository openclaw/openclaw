---
title: "Multi-Agent Results Protocol"
summary: "How dispatcher agents should scan agents:results to close the loop on delegated tasks"
read_when:
  - Building a multi-agent mesh with Redis Streams
  - An agent dispatches tasks to other agents and needs to act on completions
  - Heartbeat-driven agents are not picking up results from downstream agents
---

# Multi-Agent Results Protocol

## The Problem

When Agent A dispatches a task to Agent B via a Redis Stream inbox (`agents:tasks:agent-b`),
Agent B posts its result to a global results stream (`agents:results`). However, if Agent A's
`HEARTBEAT.md` only checks its **own inbox** (`agents:tasks:agent-a`), it will never see that
result — the result sits unclaimed in the stream until a human manually checks or the
orchestrator relays it.

This is a silent failure mode: no error is thrown, no timeout fires. The work is done but
the loop is never closed.

## The Fix: Dispatcher Protocol

Any agent that dispatches tasks to other agents must also scan `agents:results` on each
heartbeat cycle for completions of tasks it sent.

### Step 1: Check your own inbox (existing behavior)

```javascript
const bus = require("/path/to/bus_client.js");

// When dispatching a task — publishTask must include requested_by in the payload
// so the specialist can echo it back in the result:
const taskId = await bus.publishTask("specialist-agent", "Analyze X", {
  fromAgent: "my-agent", // dispatcher identity — echoed in result as requested_by
});

// When picking up a result — filter by requested_by, not from_agent
const results = await bus.getRecentResults(20);
for (const r of results) {
  if (r.requested_by === "my-agent") {
    // this result was from a task I dispatched
  }
}
```

### Step 2: Check agents:results for YOUR dispatched tasks (new)

```javascript
const results = await bus.getRecentResults(20);

for (const r of results) {
  // Filter by requested_by — the dispatcher identity from publishTask.
  // This is NOT the same as from_agent (which is the specialist's name).
  if (r.requested_by === "my-agent") {
    const alreadySeen = await bus.isResultSeen(r.task_id, "my-agent");
    if (!alreadySeen) {
      // Act on the result
      console.log(`Result from ${r.from_agent} for task ${r.task_id}: ${r.status}`);
      // → Notify the user, chain the next task, etc.
      await bus.markResultSeen(r.task_id, "my-agent");
    }
  }
}
```

### Step 3: Act — don't just log

When a result is found:

1. If the **user needs to know** → send a notification via the active channel (Telegram/Discord DM)
2. If **another agent needs this output** → publish the next task to their inbox
3. If the **pipeline is complete** → update status, archive the task chain

## Required bus_client.js Functions

Add these three functions to your bus client implementation:

### `getRecentResults(count)`

Reads the last `count` entries from the `agents:results` stream.

```javascript
async function getRecentResults(count = 20) {
  const r = await getClient();
  const entries = await r.xRevRange("agents:results", "+", "-", { COUNT: count });
  return entries.map((e) => ({ _stream_id: e.id, ...e.message }));
}
```

### `markResultSeen(taskId, agentName)`

Records that an agent has processed a result. Uses `agentName` as the Redis hash field
so each orchestrator has an independent slot — concurrent calls from different orchestrators
do not overwrite each other. 7-day TTL prevents unbounded key growth.

```javascript
async function markResultSeen(taskId, agentName) {
  const r = await getClient();
  const key = `agents:results:seen:${taskId}`;
  // Use agentName as the hash field — each orchestrator tracks independently
  await r.hSet(key, agentName, new Date().toISOString());
  await r.expire(key, 60 * 60 * 24 * 7); // 7-day TTL
}
```

### `isResultSeen(taskId, agentName)`

Returns `true` if **this specific agent** has already processed the result, preventing
re-processing on the next heartbeat cycle. Reads the agent's own field — not a shared
`seen_by` field — so one orchestrator marking a result seen does not silence others.

```javascript
async function isResultSeen(taskId, agentName) {
  const r = await getClient();
  const key = `agents:results:seen:${taskId}`;
  // Read the agent-specific field so each orchestrator tracks independently
  const val = await r.hGet(key, agentName);
  return val !== null;
}
```

## Updated HEARTBEAT.md Protocol

For any agent that dispatches tasks, the heartbeat protocol should follow this order:

```markdown
## Step 1: Check my inbox (agents:tasks:my-agent)

→ process any pending tasks assigned to me

## Step 2a: Process tasks

→ set status busy, do the work, publish result, set status idle

## Step 2b: Check agents:results for MY dispatched tasks ← THIS IS THE CRITICAL ADDITION

→ for each unseen result where requested_by === 'my-agent': - act on it (notify user, chain next task, etc.) - mark it seen

## Step 3: No tasks, no pending results → HEARTBEAT_OK
```

## Why This Matters

Without this protocol, a multi-agent pipeline stalls silently:

```
User → Orchestrator → dispatches to Specialist (research)
Specialist completes → posts to agents:results ✅
Orchestrator heartbeat fires → checks agents:tasks:orchestrator (empty) → HEARTBEAT_OK ❌
```

The result sits in `agents:results` indefinitely. The orchestrator never picks it up,
never notifies the user, never chains the next step.

With the dispatcher protocol:

```
Orchestrator heartbeat fires → checks agents:tasks:orchestrator (empty)
                             → checks agents:results for own dispatched tasks ← NEW
                             → finds Specialist's completed result
                             → notifies user, chains next task
                             → marks result seen
                             → HEARTBEAT_OK ✅
```

## Real-World Discovery

This gap was discovered in a live multi-agent deployment when an orchestrator agent
dispatched a research task to a specialist agent. The specialist completed the task and
posted the result to `agents:results`. The orchestrator's next heartbeat fired, checked
only its own inbox, found nothing, and returned `HEARTBEAT_OK` — never surfacing the
completed result to the user or chaining the next step.

The fix was implemented, tested, and validated in that deployment before being
contributed back to OpenClaw.

## Field Lifecycle (Critical)

The `requested_by` field is the thread that connects the task to its result across agents:

```
Dispatcher calls publishTask()
  → writes requested_by=<dispatcher> to agents:tasks:{specialist}
  → specialist receives task { requested_by: <dispatcher>, ... }
  → specialist calls publishResult(..., requestedBy=task.requested_by)
  → result written to agents:results { requested_by: <dispatcher>, ... }
  → dispatcher heartbeat scans agents:results, filters requested_by === self
```

Without this chain, the dispatcher cannot distinguish "results from my tasks" from
"results from other dispatchers' tasks" when multiple orchestrators share the same bus.

## Redis Key Reference

| Key Pattern                     | Type   | Description                                      |
| ------------------------------- | ------ | ------------------------------------------------ |
| `agents:tasks:{name}`           | Stream | Agent's task inbox — includes `requested_by`     |
| `agents:results`                | Stream | Global results stream — includes `requested_by`  |
| `agents:results:seen:{task_id}` | Hash   | Tracks which agents have processed which results |
| `agent:{name}:status`           | Hash   | Agent status: idle / busy / blocked              |
