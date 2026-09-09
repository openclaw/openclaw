---
summary: "Recursive delegation depth, the announce chain, cascade stop, and how sub-agent auth resolves"
title: "Nested sub-agents and authentication"
read_when:
  - You are building an orchestrator that spawns its own children
  - You need the depth caps and per-agent child limits
  - You need to know which auth profile a sub-agent uses
---

## Nested sub-agents

By default, sub-agents can recursively delegate through depth `5`. Global
concurrency, per-session child limits, inherited tool policy, sandbox
inheritance, and target-agent allowlists still apply. Set a lower depth to
create leaf workers sooner.

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxSpawnDepth: 2, // stop nesting after depth 2 (default: 5, range 1-5)
        maxChildrenPerAgent: 5, // max active children per agent session (default: 5, range 1-20)
        maxConcurrent: 8, // global concurrency lane cap (default: 8)
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
final answer, the correct follow-up is the exact silent token
`NO_REPLY` / `no_reply`.
</Note>

### Tool policy by depth

- A child captures the requester's effective sender policy when it is spawned. Senderless child runs and authenticated operator resumes keep that snapshot even if `toolsBySender` changes later; current global, agent, provider, sandbox, and sub-agent restrictions still apply. A new external channel turn targeting the child re-resolves current sender policy instead.
- Role and control scope are written into session metadata at spawn time for provenance. The current depth policy is authoritative, so existing sessions gain or lose recursive orchestration tools when the configured cap changes.
- **Orchestrator (below `maxSpawnDepth`):** gets `sessions_spawn`, `subagents`, `sessions_list`, `sessions_history` so it can spawn children and inspect their status. Other session/system tools remain denied.
- **Leaf (at `maxSpawnDepth`):** no recursive orchestration tools.

### Per-agent spawn limit

Each agent session (at any depth) can have at most `maxChildrenPerAgent`
(default `5`) active children at a time. This prevents runaway fan-out
from a single orchestrator.

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
fallbacks. Fully isolated auth per agent is not supported yet.
