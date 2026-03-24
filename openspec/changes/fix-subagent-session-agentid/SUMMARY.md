# SUMMARY

I traced the spawn path end-to-end.

## What is already correct

- `src/agents/subagent-spawn.ts::spawnSubagentDirect()` creates the right child key:
  - `agent:<targetAgentId>:subagent:<uuid>`
- `src/gateway/server-methods/agent.ts::agentHandlers.agent` preserves that child key and registers the run context with it.

So the bug is **not** that `sessions_spawn` builds `agent:main:subagent:*` when you asked for `mew`.

## Where attribution actually goes wrong

Two later code paths can re-derive the wrong agent identity:

1. **Transcript creation path**
   - `src/config/sessions/paths.ts::resolveSessionFilePathOptions()`
   - `src/config/sessions/paths.ts::resolveSessionFilePath()`
   - new transcripts fall back to the directory implied by `storePath`, not the canonical child `agentId`

2. **Usage/activity discovery path**
   - `src/gateway/server-methods/usage.ts::discoverAllSessionsForUsage()`
   - discovered sessions are stamped with the outer scan-loop `agent.id`
   - current buggy line:
     ```ts
     return sessions.map((session) => ({ ...session, agentId: agent.id }));
     ```

That is the concrete emission point that can turn a real child session into `agentId: "main"` downstream.

## Fix shape

- Make new transcript fallback prefer `opts.agentId`
- Make usage discovery prefer canonical store/session identity by `sessionId`, only falling back to scan-loop `agent.id` as a last resort

## Why this matters

It fixes the actual observed payload mismatch:

- title: `mew-real-attribution-check`
- wrong today: `agentId: "main"`
- expected after fix: `agentId: "mew"`
