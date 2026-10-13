---
summary: "Recursive delegation depth, the announce chain, cascade stop, and how sub-agent auth and memory audience resolve"
title: "Nested sub-agents and authentication"
read_when:
  - You are building an orchestrator that spawns its own children
  - You need the depth caps and per-agent child limits
  - You need to know which auth profile a sub-agent uses
  - You need to know how a child inherits memory audience
---

## Nested sub-agents

By default, sub-agents can recursively delegate through depth `5`. Per-session
execution and child admission limits, inherited tool policy, sandbox
inheritance, and target-agent allowlists still apply. Set a lower depth to
create leaf workers sooner.

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxSpawnDepth: 2, // stop nesting after depth 2 (default: 5, range 1-5)
        maxChildrenPerAgent: 5, // max active children per agent session (default: 5, range 1-20)
        maxConcurrent: 8, // concurrent child runs per spawning session (default: 8)
        runTimeoutSeconds: 900, // default timeout for sessions_spawn (0 = no timeout)
        announceTimeoutMs: 120000, // gateway announce timeout, excluding accepted queue waits
      },
    },
  },
}
```

### Depth levels

| Depth | Session key shape                          | Default role | Can spawn?                     |
| ----- | ------------------------------------------ | ------------ | ------------------------------ |
| 0     | `agent:<id>:main`                          | Main agent   | Always                         |
| 1     | `agent:<id>:subagent:<uuid>`               | Orchestrator | Yes, unless `maxSpawnDepth: 1` |
| 2-4   | Persisted flat sub-agent keys with lineage | Orchestrator | Yes, by default                |
| 5     | Persisted flat sub-agent key with lineage  | Leaf         | No, at the default boundary    |

### Announce chain

Results flow back one level at a time:

1. A descendant finishes and announces to its direct parent.
2. That parent synthesizes its children before finishing and announcing upward.
3. The main agent receives the final announce and delivers to the user.

Each level only sees announces from its direct children.

<Note>
**Operational guidance:** start child work once and wait for completion
events instead of building poll loops around `sessions_list`,
`sessions_history`, `/subagents list`, or `exec` sleep commands.
`sessions_list` and `/subagents list` keep child-session relationships
focused on live work — live children remain attached, ended children stay
visible for a short recent window, and stale store-only child links are
ignored after their freshness window. This prevents old `spawnedBy` /
`parentSessionKey` metadata from resurrecting ghost children after
restart. If a child completion event arrives after you already sent the
final answer, review it and continue any unfinished work. Avoid repeating an
already delivered update. Internal orchestration still requires a meaningful
result; a silent token cannot settle the child task.
</Note>

### Tool policy by depth

- A child captures the requester's effective sender policy when it is spawned. Senderless child runs and authenticated operator resumes keep that snapshot even if `toolsBySender` changes later; current global, agent, provider, sandbox, and sub-agent restrictions still apply. A new external channel turn targeting the child re-resolves current sender policy instead.
- Role and control scope are written into session metadata at spawn time for provenance. The current depth policy is authoritative, so existing sessions gain or lose recursive orchestration tools when the configured cap changes.
- **Orchestrator (below `maxSpawnDepth`):** gets `sessions_spawn`, `subagents`, `sessions_list`, `sessions_history` so it can spawn children and inspect their status. Other session/system tools remain denied.
- **Leaf (at `maxSpawnDepth`):** no recursive orchestration tools.

### Per-agent spawn limit

Each agent session (at any depth) can have at most `maxChildrenPerAgent`
(default `5`) active children at a time. This prevents runaway fan-out
from a single orchestrator. Separately, `maxConcurrent` limits executing child
runs for that immediate spawning session. Each nested orchestrator gets its own
execution budget; its children do not share the root session's slots.

### Reset a conversation

A full in-place conversation reset cancels unfinished native subagents associated with that session, including yielded children and children whose completion requester differs from their controller. Chat `/reset` and `sessions.reset` use the same cleanup owner. If child cancellation is incomplete, reset reports a failure before clearing the conversation; inspect the remaining tasks and retry. Child transcripts and unrelated sessions are preserved.

### Cascade stop

Explicit cancellation of an orchestrator cascades through its descendant
tree. `/stop` in the main chat applies to that requester's child tree.
See [Stopping](/tools/subagents/operations#stopping) for scope and incomplete-cancellation behavior.

## Authentication

Sub-agent auth is resolved by **agent id**, not by session type:

- The sub-agent session key is `agent:<agentId>:subagent:<uuid>`.
- The local auth overlay is loaded from that agent's `agentDir`.
- The shared auth profiles are merged in as a **fallback**; agent profiles override shared profiles on conflicts.

The merge is additive, so shared profiles are always available as
fallbacks. There is no setting that isolates an agent's auth from the shared
profiles.

### Memory audience inheritance

OpenClaw `sessions_spawn` (including ACP runtimes) and realtime voice consults
record the immediate parent key (`spawnedBy`), exact parent session id
(`spawnedBySessionId`), parent lifecycle revision
(`parentSessionLifecycleRevision`), and the spawning invocation's trusted owner
status (`spawnedBySenderIsOwner`). These are host-owned facts, not tool arguments
or `sessions.patch` fields. The owner flag is never inferred from a child's
synthetic launch authority; voice consults take it only from the caller's
ingress authentication. Missing or false owner status does not grant owner
access.

For memory access, OpenClaw validates every parent hop against the current parent
incarnation and lifecycle, including same-id resets. It then supplies the
host-minted root audience to memory providers and plugin tools. Providers must
consume that prepared audience and must not walk session lineage or infer memory
authority from session lookups.

A child reset preserves its recorded parent grant, so a newly resolved audience
can still inherit from the same root. A reset or removal of any recorded parent
invalidates an already captured audience, so the next protected provider or tool
operation fails its audience currency check. Later turns of that child receive
no memory audience. With a native memory provider, the Gateway log warns that the
child's lineage is stale and that it must be respawned or recreated from a current
session; resetting the child keeps the stale lineage. Legacy children without the
complete lineage stamps receive no inherited memory audience: their turns run
without private or conversation memory, and the Gateway log warns that the
session predates memory lineage receipts and must be respawned from its parent.
Children whose parents lack a lifecycle revision must be respawned after the
parent's next reset, which establishes a current lifecycle revision.

This contract covers OpenClaw-created child sessions. Native runtime child threads
also need their runtime's tool bridge to provide a live authorized invocation;
lineage metadata alone does not add that bridge.
