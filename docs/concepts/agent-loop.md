---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Agent loop lifecycle, streams, and wait semantics"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need an exact walkthrough of the agent loop or lifecycle events（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Agent Loop"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Agent Loop (OpenClaw)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
An agentic loop is the full “real” run of an agent: intake → context assembly → model inference →（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tool execution → streaming replies → persistence. It’s the authoritative path that turns a message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
into actions and a final reply, while keeping session state consistent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In OpenClaw, a loop is a single, serialized run per session that emits lifecycle and stream events（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
as the model thinks, calls tools, and streams output. This doc explains how that authentic loop is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
wired end-to-end.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Entry points（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway RPC: `agent` and `agent.wait`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: `agent` command.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How it works (high-level)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `agent` RPC validates params, resolves session (sessionKey/sessionId), persists session metadata, returns `{ runId, acceptedAt }` immediately.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. `agentCommand` runs the agent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - resolves model + thinking/verbose defaults（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - loads skills snapshot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - calls `runEmbeddedPiAgent` (pi-agent-core runtime)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - emits **lifecycle end/error** if the embedded loop does not emit one（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. `runEmbeddedPiAgent`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - serializes runs via per-session + global queues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - resolves model + auth profile and builds the pi session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - subscribes to pi events and streams assistant/tool deltas（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - enforces timeout -> aborts run if exceeded（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - returns payloads + usage metadata（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. `subscribeEmbeddedPiSession` bridges pi-agent-core events to OpenClaw `agent` stream:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - tool events => `stream: "tool"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - assistant deltas => `stream: "assistant"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - lifecycle events => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. `agent.wait` uses `waitForAgentJob`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - waits for **lifecycle end/error** for `runId`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - returns `{ status: ok|error|timeout, startedAt, endedAt, error? }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Queueing + concurrency（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runs are serialized per session key (session lane) and optionally through a global lane.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- This prevents tool/session races and keeps session history consistent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messaging channels can choose queue modes (collect/steer/followup) that feed this lane system.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  See [Command Queue](/concepts/queue).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Session + workspace preparation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Workspace is resolved and created; sandboxed runs may redirect to a sandbox workspace root.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skills are loaded (or reused from a snapshot) and injected into env and prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bootstrap/context files are resolved and injected into the system prompt report.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A session write lock is acquired; `SessionManager` is opened and prepared before streaming.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Prompt assembly + system prompt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- System prompt is built from OpenClaw’s base prompt, skills prompt, bootstrap context, and per-run overrides.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model-specific limits and compaction reserve tokens are enforced.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- See [System prompt](/concepts/system-prompt) for what the model sees.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Hook points (where you can intercept)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw has two hook systems:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Internal hooks** (Gateway hooks): event-driven scripts for commands and lifecycle events.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Plugin hooks**: extension points inside the agent/tool lifecycle and gateway pipeline.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Internal hooks (Gateway hooks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`agent:bootstrap`**: runs while building bootstrap files before the system prompt is finalized.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Use this to add/remove bootstrap context files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Command hooks**: `/new`, `/reset`, `/stop`, and other command events (see Hooks doc).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Hooks](/automation/hooks) for setup and examples.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Plugin hooks (agent + gateway lifecycle)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These run inside the agent loop or gateway pipeline:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`before_agent_start`**: inject context or override system prompt before the run starts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`agent_end`**: inspect the final message list and run metadata after completion.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`before_compaction` / `after_compaction`**: observe or annotate compaction cycles.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`before_tool_call` / `after_tool_call`**: intercept tool params/results.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`tool_result_persist`**: synchronously transform tool results before they are written to the session transcript.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`message_received` / `message_sending` / `message_sent`**: inbound + outbound message hooks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`session_start` / `session_end`**: session lifecycle boundaries.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`gateway_start` / `gateway_stop`**: gateway lifecycle events.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Plugins](/tools/plugin#plugin-hooks) for the hook API and registration details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Streaming + partial replies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Assistant deltas are streamed from pi-agent-core and emitted as `assistant` events.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Block streaming can emit partial replies either on `text_end` or `message_end`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reasoning streaming can be emitted as a separate stream or as block replies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- See [Streaming](/concepts/streaming) for chunking and block reply behavior.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool execution + messaging tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool start/update/end events are emitted on the `tool` stream.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool results are sanitized for size and image payloads before logging/emitting.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messaging tool sends are tracked to suppress duplicate assistant confirmations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Reply shaping + suppression（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Final payloads are assembled from:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - assistant text (and optional reasoning)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - inline tool summaries (when verbose + allowed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - assistant error text when the model errors（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `NO_REPLY` is treated as a silent token and filtered from outgoing payloads.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messaging tool duplicates are removed from the final payload list.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If no renderable payloads remain and a tool errored, a fallback tool error reply is emitted（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (unless a messaging tool already sent a user-visible reply).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Compaction + retries（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-compaction emits `compaction` stream events and can trigger a retry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On retry, in-memory buffers and tool summaries are reset to avoid duplicate output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- See [Compaction](/concepts/compaction) for the compaction pipeline.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Event streams (today)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `lifecycle`: emitted by `subscribeEmbeddedPiSession` (and as a fallback by `agentCommand`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `assistant`: streamed deltas from pi-agent-core（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tool`: streamed tool events from pi-agent-core（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Chat channel handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Assistant deltas are buffered into chat `delta` messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A chat `final` is emitted on **lifecycle end/error**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Timeouts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agent.wait` default: 30s (just the wait). `timeoutMs` param overrides.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent runtime: `agents.defaults.timeoutSeconds` default 600s; enforced in `runEmbeddedPiAgent` abort timer.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Where things can end early（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent timeout (abort)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- AbortSignal (cancel)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway disconnect or RPC timeout（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agent.wait` timeout (wait-only, does not stop agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
