# PR: Add tool_invocation provenance for A2A tool calls

## Summary

Extends `inputProvenance` to support agent-to-agent tool invocations, enabling structured multi-agent workflows with full provenance tracking.

## Related Work

- **#15154** — Fixed session path resolution for multi-agent (merged 2026-02-13)
- **#10486** — A2A protocol plugin for external agent communication
- **#7516** — Auto-inject From:/To: identity headers in agent-to-agent messages
- **#10999** — A2A announce delivery fix

This PR is the missing piece: provenance fields for internal `agent_call`/`debate_call` tools.

## The Problem

OpenClaw has two agent communication modes:

- `sessions_spawn` — Ephemeral sub-agent for fire-and-forget tasks
- `sessions_send` — Unstructured text between persistent sessions

**What's missing:** Structured skill invocation between peers. Agents couldn't call each other with declared capabilities, receive structured responses, or track what skill was invoked.

The `agent_call` and `debate_call` tools EXIST and WORK, but their provenance is incomplete:

- They currently send `kind: "inter_session"` (same as sessions_send)
- They **don't** include `skill` or `mode` fields
- Target agents can't distinguish tool calls from generic inter-session messages
- Target agents don't know what skill was invoked or in what mode

## The Solution

Complete the provenance pipeline:

| Change                                       | File                                        |
| -------------------------------------------- | ------------------------------------------- |
| Add `"tool_invocation"` to kind enum         | `src/sessions/input-provenance.ts`          |
| Add `skill?: string` to InputProvenance type | `src/sessions/input-provenance.ts`          |
| Add `mode?: string` to InputProvenance type  | `src/sessions/input-provenance.ts`          |
| Update `normalizeInputProvenance()`          | `src/sessions/input-provenance.ts`          |
| Add fields to TypeBox schema                 | `src/gateway/protocol/schema/agent.ts`      |
| Update tools to use `"tool_invocation"` kind | `agent-call-tool.ts`, `debate-call-tool.ts` |
| Add helper functions for provenance checking | `src/sessions/input-provenance.ts`          |

### Helper Functions

- `isToolInvocationProvenance(value)` — Check if provenance is a tool invocation
- `isCrossSessionProvenance(value)` — Check if provenance is any cross-session communication (`inter_session` or `tool_invocation`)
- `hasInterSessionUserProvenance(message)` — Updated to use `isCrossSessionProvenance()` so tool invocations are filtered correctly

## Use Cases

### 1. Peer-to-Peer Skill Invocation

```
Atlas calls Clio.investigate({query: "...", depth: "deep"})
  ↓
Clio sees provenance: {kind: "tool_invocation", skill: "investigate", mode: "execute"}
  ↓
Clio routes to research workflow, returns structured {findings, sources, confidence}
```

### 2. Multi-Agent Debate

```
debate_call({proposer: Atlas, critics: [Metis, Mentor], resolver: Atlas})
  ↓
Each participant sees full provenance: what skill, what mode, who requested
  ↓
Confidence progression tracked across rounds
```

### 3. Service Discovery

Agents advertise capabilities (research, critique, investigate) and call each other directly. No orchestrator bottleneck.

## Design Decisions

| Decision                          | Rationale                                          |
| --------------------------------- | -------------------------------------------------- |
| Add to existing provenance system | Minimal change, consistent with existing patterns  |
| Schemaless services               | Let agents discover capabilities organically       |
| `tool_invocation` kind            | Distinguishes from `inter_session` (sessions_send) |
| `skill` field                     | Target knows what capability was invoked           |
| `mode` field                      | Target knows execute vs critique mode              |

## What This Enables

| Before                                      | After                                         |
| ------------------------------------------- | --------------------------------------------- |
| Agent sees "from another session"           | Agent sees "from agent_call, skill=X, mode=Y" |
| Skill routing requires parsing message body | Skill routing via provenance fields           |
| Incomplete logging                          | Full call chain visible                       |
| Mode tracking lost                          | Agent distinguishes execute vs critique       |

## Security Considerations

This change is additive only:

- No new attack surface (provenance already validated)
- No new fields exposed (skill/mode are caller-provided)
- Consistent with existing validation patterns

## Testing

Verified in production multi-agent environment:

- ✅ Bidirectional A2A (Atlas ↔ Metis)
- ✅ Service invocation (research, consult, ping, investigate)
- ✅ Graceful failure (unknown skill → helpful response)
- ✅ Provenance tracking (sourceSessionKey, sourceTool preserved)
- ✅ Multiple agents (5+ agents: main, metis, clio, deepthought, mentor)

## Related Issues

Multi-agent context from recent bug reports:

- **#15141** — Session path validation failure in multi-agent setups (fixed by #15154)
- **#15245** — resolveSessionFilePath missing agentId
- **#15601** — Multi-agent session path resolution issues

These demonstrate the complexity of multi-agent routing. Proper provenance tracking helps debug these scenarios.

## Files Changed

- `src/sessions/input-provenance.ts` — Add `tool_invocation` kind, `skill`/`mode` fields to type and normalizer; add helper functions `isToolInvocationProvenance()` and `isCrossSessionProvenance()`; update `hasInterSessionUserProvenance()` to use `isCrossSessionProvenance()`
- `src/gateway/protocol/schema/agent.ts` — Add `skill`/`mode` fields to TypeBox schema
- `src/agents/tools/agent-call-tool.ts` — Change `kind` from `"inter_session"` to `"tool_invocation"`, add `skill`/`mode` (2 locations)
- `src/agents/tools/debate-call-tool.ts` — Change `kind` from `"inter_session"` to `"tool_invocation"`, add `skill`/`mode`

## Breaking Changes

None. This is additive only.

---

**AI-assisted:** Claude + battle-tested in production multi-agent environment

**Co-authored-by:** Metis (A2A architecture rationale)
