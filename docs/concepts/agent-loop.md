---
summary: "Agent loop lifecycle, streams, and wait semantics"
read_when:
  - You need an exact walkthrough of the agent loop or lifecycle events
---
# Agent Loop (Clawdis)

Short, exact flow of one agent run. Source of truth: current code in `src/`.

## Entry points
- Gateway RPC: `agent` and `agent.wait` in [`src/gateway/server-methods/agent.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/gateway/server-methods/agent.ts).
- CLI: `agentCommand` in [`src/commands/agent.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/commands/agent.ts).

## High-level flow
1) `agent` RPC validates params, resolves session (sessionKey/sessionId), persists session metadata, returns `{ runId, acceptedAt }` immediately.
2) `agentCommand` runs the agent:
   - resolves model + thinking/verbose defaults
   - loads skills snapshot
   - calls `runEmbeddedPiAgent` (pi-agent-core runtime)
   - emits **lifecycle end/error** if the embedded loop does not emit one
3) `runEmbeddedPiAgent`:
   - builds `AgentSession` and subscribes to pi events
   - streams assistant deltas + tool events
   - enforces timeout -> aborts run if exceeded
   - returns payloads + usage metadata
4) `subscribeEmbeddedPiSession` bridges pi-agent-core events to Clawdis `agent` stream:
   - tool events => `stream: "tool"`
   - assistant deltas => `stream: "assistant"`
   - lifecycle events => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5) `agent.wait` uses `waitForAgentJob`:
   - waits for **lifecycle end/error** for `runId`
   - returns `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## Event streams (today)
- `lifecycle`: emitted by `subscribeEmbeddedPiSession` (and as a fallback by `agentCommand`)
- `assistant`: streamed deltas from pi-agent-core
- `tool`: streamed tool events from pi-agent-core

## Chat provider handling
- `createAgentEventHandler` in [`src/gateway/server-chat.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/gateway/server-chat.ts):
  - buffers assistant deltas
  - emits chat `delta` messages
  - emits chat `final` when **lifecycle end/error** arrives

## Timeouts
- `agent.wait` default: 30s (just the wait). `timeoutMs` param overrides.
- Agent runtime: `agent.timeoutSeconds` default 600s; enforced in `runEmbeddedPiAgent` abort timer.

## Where things can end early
- Agent timeout (abort)
- AbortSignal (cancel)
- Gateway disconnect or RPC timeout
- `agent.wait` timeout (wait-only, does not stop agent)

## Files
- [`src/gateway/server-methods/agent.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/gateway/server-methods/agent.ts)
- [`src/gateway/server-methods/agent-job.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/gateway/server-methods/agent-job.ts)
- [`src/commands/agent.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/commands/agent.ts)
- [`src/agents/pi-embedded-runner.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/agents/pi-embedded-runner.ts)
- [`src/agents/pi-embedded-subscribe.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/agents/pi-embedded-subscribe.ts)
- [`src/gateway/server-chat.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/gateway/server-chat.ts)
