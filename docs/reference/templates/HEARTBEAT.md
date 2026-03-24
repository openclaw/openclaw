---
title: "HEARTBEAT.md Template"
summary: "Workspace template for HEARTBEAT.md"
read_when:
  - Bootstrapping a workspace manually
---

# HEARTBEAT.md Template

````markdown
# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.

---

## Multi-Agent Dispatcher Protocol (if this agent dispatches tasks to others)

If this agent uses a Redis message bus to dispatch tasks to specialist agents,
it MUST also scan `agents:results` on each heartbeat for completions.

**Failure to do this causes silent pipeline stalls:** completed results sit unclaimed
in the stream and are never surfaced to the user or chained to the next step.

See: [Multi-Agent Results Protocol](/concepts/multi-agent-results-protocol)

### Heartbeat order for dispatcher agents:

1. Check own inbox (`agents:tasks:{agent-name}`) for incoming tasks
2. Process any pending tasks
3. **Check `agents:results` for completions of tasks I dispatched** ← critical
4. Act on found results (notify user, chain next agent, mark seen)
5. If nothing pending → `HEARTBEAT_OK`

```javascript
// Step 3 — check for results of my dispatched tasks
const results = await bus.getRecentResults(20);
for (const r of results) {
  if (r.requested_by === "MY_AGENT_NAME") {
    const seen = await bus.isResultSeen(r.task_id, "MY_AGENT_NAME");
    if (!seen) {
      // act on r.result here
      await bus.markResultSeen(r.task_id, "MY_AGENT_NAME");
    }
  }
}
```
````
