---
summary: "Agent loop lifecycle, streams, and wait semantics"
read_when:
  - You need an exact walkthrough of the agent loop or lifecycle events
  - You are changing session queueing, writer claims, or transcript write fencing
title: "Agent loop"
---

The agent loop is the serialized, per-session run that turns a message into
actions and a reply: intake, context assembly, model inference, tool
execution, streaming, persistence.

## Entry points

- Gateway RPC: `agent` and `agent.wait`.
- CLI: `openclaw agent`.

## Run sequence

1. `agent` RPC validates params, resolves the session (`sessionKey`/`sessionId`), persists session metadata, and returns `{ runId, acceptedAt }` immediately.
2. `agentCommand` runs the turn: resolves model + thinking/verbose/trace defaults, loads the skills snapshot, calls `runEmbeddedAgent`, and emits a fallback **lifecycle end/error** if the embedded loop did not already emit one.
3. `runEmbeddedAgent`: reserves the session controller turn before entering global capacity, resolves model + auth profile, builds the OpenClaw session, subscribes to runtime events, streams assistant/tool deltas, enforces the current model attempt's timeout (aborting that attempt on expiry), and returns payloads plus usage metadata. For Codex app-server turns, native Codex owns provider liveness and the exact `turn/completed` outcome; quiet periods and assistant output do not end the turn.
4. `subscribeEmbeddedAgentSession` bridges runtime events to the `agent` stream: tool events to `stream: "tool"`, assistant deltas to `stream: "assistant"`, lifecycle events to `stream: "lifecycle"` (`phase: "start" | "finishing" | "end" | "error"`).
5. `agent.wait` waits for the terminal outcome on a `runId` and returns `{ status: ok|error|timeout, startedAt, endedAt, error? }`. Gateway RPC runs also wait for their terminal replay payload to be published, so a duplicate request after a terminal wait result can replay that outcome.

For embedded OpenAI Responses turns, `response.completed` finishes one model
response. If the provider sends `end_turn: false`, the loop requests another
response even when the completed response contains only text. Existing
cancellation, host stop decisions, and intentional tool termination still apply.

Each completed or incomplete Responses response also carries an
`openai_responses_terminal` entry in the saved assistant message's `diagnostics`.
It records `eventType` and the provider's `endTurn` signal as
`true`, `false`, `"absent"`, or `"invalid"`, without retaining malformed values.
Read it alongside the message's `stopReason` and text phase. These per-response
facts survive later responses in the same run and require no
raw-stream logging. They record the provider signal, not whether a host stop or
cancellation prevented continuation. Older messages without this diagnostic
cannot establish whether the provider omitted the signal.

The wait result also carries the run's `terminalReply` and, when available,
`terminalReceipt`. A receipt with `sourceReplyDelivered: true` confirms a final
reply reached the external source conversation. A2A announcements consume that
fact instead of using display-history mirrors as delivery evidence.

When a provider rejects a malformed tool call before dispatch, the built-in
runner can continue once from the current transcript after earlier tools have
settled. Earlier failed tools do not block this continuation when every failure
carries host evidence that execution never started and its result already
precedes the rejected response in the current turn. Failures that may have caused
side effects, unfinished tools, and asynchronous work still block it; the
continuation does not replay the original task or increase the retry budget.

Recovery history stays available across attempts within the same run. The run
releases message payloads from replaced recovery envelopes and when it ends,
including envelopes retained by copied attempt parameters. Each accepted
transcript write keeps its original attempt's persistence callbacks until it
finishes, even after a reused manager binds a newer attempt or the bounded
teardown wait expires.
Completed attempt results stay outside the scope captured by retained harness
callbacks, so those callbacks cannot keep completed message snapshots alive.
Finalization and retry owners retain access to the results while processing them.

## Queueing and concurrency

The session controller serializes turns by physical session identity before global capacity admission. Messaging channels choose a queue mode (steer/followup/collect/interrupt) over the same ordered inputs; direct native producers use that selector too. Nested compaction borrows the exact admitted turn rather than queuing behind itself. See [Command Queue](/concepts/queue).

Before streaming, an admitted run records its durable `activeWriterRunId` claim. Every transcript append or rewrite supplies `expectedWriterRunId`, and the synchronous commit transaction verifies that it still matches the active claim. A superseded run therefore cannot commit stale transcript data. The SQLite writer queue orders per-agent mutations, while the Gateway state-directory lock prevents another Gateway or `openclaw agent --local` process from owning the same state directory concurrently.

## Session and workspace preparation

- Workspace is resolved and created; sandboxed runs may redirect to a sandbox workspace root.
- Skills are loaded (or reused from a snapshot) and injected into env and prompt.
- Embedded global, plugin, and project settings are prepared once per session and reused across turns. Config or plugin changes, workspace or agent-directory changes, and session reset refresh that snapshot. Direct edits to `settings.json` take effect in a new or reset session. Authentication and model runtimes remain outside this settings cache; model-specific compaction limits and attempt-local settings remain fresh for each turn.
- Bootstrap/context files are resolved and injected into the system prompt.
- The session transcript target and writer claim are prepared before streaming starts. Later rewrites, compaction, and truncation use the same in-transaction writer-claim fence.

## Prompt assembly

System prompt is built from OpenClaw's base prompt, skills prompt, bootstrap context, and per-run overrides. Model-specific limits and compaction reserve tokens are enforced. See [System prompt](/concepts/system-prompt) for what the model sees.

## Hooks

OpenClaw has two in-process hook systems:

- **Internal hooks**: `HOOK.md` scripts for command and lifecycle events such as `command:new`.
- **Plugin hooks**: typed `api.on(...)` handlers inside the agent/tool lifecycle and Gateway pipeline, such as `before_tool_call`.

[HTTP webhooks](/automation/cron-jobs#webhooks) are separate: they accept external requests that trigger work, rather than subscribing to agent-loop events.

### Internal hooks (Gateway hooks)

- **`agent:bootstrap`**: runs while building bootstrap files before the system prompt is finalized. Use it to add or remove bootstrap context files.
- **Command hooks**: core emits `command:new`, `command:reset`, and `command:stop`. Other command names do not automatically become hook events.

See [Hooks](/automation/hooks) for setup and examples.

### Plugin hooks

These run inside the agent loop or gateway pipeline:

| Hook                                                    | Runs                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before_model_resolve`                                  | Pre-session (no `messages`), to override provider/model before resolution using fixed rules.                                                                                                                                                                                                                                                                                                                        |
| `before_prompt_build`                                   | After session load (with `messages`), to inject `prependContext`, `systemPrompt`, `prependSystemContext`, or `appendSystemContext`, or, on supported runtimes with a turn-scoped submitted tool surface, narrow it with `toolsAllow`. An empty `toolsAllow` submits no optional tools; omitted leaves the host-resolved surface unchanged. Unsupported runtimes reject restrictive values instead of ignoring them. |
| `before_agent_reply`                                    | After inline actions, before the LLM call. Lets a plugin claim the turn and return a synthetic reply or silence it entirely.                                                                                                                                                                                                                                                                                        |
| `agent_end`                                             | After completion, with the final message list and run metadata.                                                                                                                                                                                                                                                                                                                                                     |
| `before_compaction` / `after_compaction`                | Observe compaction cycles; these hooks do not rewrite or veto compaction.                                                                                                                                                                                                                                                                                                                                           |
| `before_tool_call` / `after_tool_call`                  | Intercept tool params/results.                                                                                                                                                                                                                                                                                                                                                                                      |
| `before_install`                                        | After operator install policy runs, on staged skill/plugin install material, when plugin hooks are loaded in the current process.                                                                                                                                                                                                                                                                                   |
| `tool_result_persist`                                   | Synchronously transforms tool results before they are written to an OpenClaw-owned session transcript.                                                                                                                                                                                                                                                                                                              |
| `message_received` / `message_sending` / `message_sent` | Inbound and outbound message hooks.                                                                                                                                                                                                                                                                                                                                                                                 |
| `session_start` / `session_end`                         | Session lifecycle boundaries.                                                                                                                                                                                                                                                                                                                                                                                       |
| `gateway_start` / `gateway_stop`                        | Gateway lifecycle events.                                                                                                                                                                                                                                                                                                                                                                                           |

Hook decision rules for outbound/tool guards:

- `before_tool_call`: `{ block: true }` is terminal and stops lower-priority handlers. `{ block: false }` is a no-op and does not clear a prior block.
- `before_install`: same terminal/no-op semantics as above. Use `security.installPolicy`, not `before_install`, for operator-owned install allow/warn/block decisions that must cover CLI install and update paths.
- `message_sending`: `{ cancel: true }` is terminal and stops lower-priority handlers. `{ cancel: false }` is a no-op and does not clear a prior cancel.

See [Plugin hooks](/plugins/hooks) for the hook API and registration details.

Harnesses can adapt these hooks. The Codex app-server harness keeps OpenClaw plugin hooks as the compatibility contract for documented mirrored surfaces; Codex native hooks are a separate, lower-level Codex mechanism.

## Streaming

- Assistant deltas stream from the agent runtime as `assistant` events.
- Adjacent text appends already waiting in the provider event queue can merge before
  agent delivery. This adds no buffering delay; snapshots, content-block changes,
  reasoning, tools, and terminal events remain separate boundaries.
- Block streaming can emit partial replies on `text_end` or `message_end`.
- Reasoning streaming can be a separate stream or block replies.
- Serialized XML tool calls, including GLM `arg_key` payloads and `invoke`/`parameter` blocks, are hidden from streamed and final replies. Ambiguous tag prefixes wait for more text; completed literal explanations and Markdown code examples remain visible. Hiding a shadow copy does not execute it again.
- See [Streaming](/concepts/streaming) for chunking and block reply behavior.

## Tool execution

Tool arguments are validated against the tool's schema before execution. During
argument recovery, `anyOf` and `oneOf` values already accepted by a branch keep
their original value and type. For example, a string ID `"00123"` stays a string
even when a sibling integer field needs conversion from `"2"` to `2`. Recovery
tries branch conversions only when no branch accepts the original value; the
complete schema still enforces constraints such as `oneOf` exclusivity.

- Tool start/update/end events emit on the `tool` stream.
- Tool results are sanitized for size and image payloads before logging/emitting.
- Messaging tool sends are tracked to suppress duplicate assistant confirmations.
- A confirmed final send, reply, thread reply, or poll to the current source conversation ends the run loop in both automatic and message-tool delivery modes. An added reaction with explicit `final: true` on the current source message also ends it. Progress actions (`final: false`), reactions elsewhere, removals, and unconfirmed actions do not.

## Reply shaping

Final payloads are assembled from assistant text (plus optional reasoning), inline tool summaries (when verbose and allowed), and assistant error text when the model errors.

- Terminal producers recognize only a whole final that trims to uppercase `NO_REPLY`, record the terminal reply fact, and remove silent model text before delivery. Consumers forward prepared payloads without parsing the text again.
- Messaging tool duplicates are removed from the final payload list.
- A confirmed final messaging-tool reply to the current source remains completion evidence across provider retries. Progress-only, failed, partial, dry-run, and other-destination sends do not satisfy that requirement. A newly accepted steered input needs its own answer.
- A fallback tool error warning appears only when a run ends with a tool failure and would otherwise leave the user with no reply. This guard is not configurable; a user-facing reply, including one already delivered by a messaging tool, prevents the warning.

Admission sets the default reply expectation. External direct, group, and channel turns can explicitly finish with a token-only `NO_REPLY`, even when a reply was required. Subagents, private completions, Control UI chat, and other internal result-required sessions need a completed current-source final result; progress-only mirrors never satisfy that obligation. See [Silent replies](/concepts/messages#silent-replies).

An empty final is not silence. When bounded recovery exhausts with only reasoning or empty output, OpenClaw records a failed outcome. An admitted user request receives one short system notice that no answer was returned, rather than a fabricated assistant answer in history. Background and internal turns record the failure without posting that notice to chat; existing classified failure and alert paths stay unchanged. This also applies when compaction occurs between retries. Whitespace and zero-width characters alone do not count as a visible answer.

If a required-reply turn ends after a fully settled tool batch without a composed answer, OpenClaw can make a tool-free finalization pass. This includes reasoning-only stops and output-limit stops with no visible text; a lone unfinished `<tool_call>` marker is not an answer. Earlier tool errors, pre-tool progress, and superseded, undelivered confirmations do not count as a final answer. For embedded external turns, a current-source `final: false` text send can count as the answer at settlement only when it belongs to the last tool batch and the turn then ends empty or silent. Result-required internal turns still need an actual completed final result. Any later tool work, including work after an asynchronous progress send, still gets a finalization pass. This pass uses the settled results and does not repeat completed tools. Fatal automation failures, including denied execution, remain failures even when finalization produces an answer.

An external turn that explicitly finishes with `NO_REPLY` does not need a finalization pass, even after a settled tool failure. The failure remains recorded. `NO_REPLY` discards anything written this turn that was not sent, so send confirmations before ending silently.

Node worker turns use the same settled-tool recovery when the model returns an empty final. The worker makes one tool-free follow-up request. If that request also returns no answer, the turn reports a failure. A worker turn that starts background commands which are still running ends with an explicit status and their process session IDs; it does not claim their results are complete.

A confirmed delivery prevents duplicate generation. Pending delivery or continuation work retains completion ownership without being marked delivered; rejected sends, unflushed deferred text, and missing delivery callbacks are not delivery proof. `NO_REPLY` does not retract text already delivered. Pending tools, accepted child runs, and yielded work keep their existing owners, and assistant errors and aborts are not intentional silence.

Prompt-segment diagnostics attribute attachment/context blocks and generated inbound metadata separately from user text. A prompt containing only those blocks does not need trailing user text for reply processing to complete.

## Compaction and retries

In Control UI chat, recovery stays beside the working indicator rather than
creating a message for every failed attempt. Same-model retry status includes
its attempt count and an absolute retry time for backoff display. Model fallback
transitions remain available when reconnecting to an active run.

Once recovery ends in failure, chat shows one run-owned failure notice. Useful
partial text and media remain separate from that notice. Failed-attempt
diagnostics stay in the raw transcript; display history collapses them by run
identity, not by comparing error text.

When an OpenAI Responses request hits its output limit while generating a tool
call, the built-in harness finishes already admitted tools and retries from their
recorded results. The unfinished call never executes. Recovery uses the existing
bounded session retry budget and remains cancellable; refusals and inconsistent
terminal responses do not qualify for this continuation.

An empty `length` response also qualifies when it leaves no completed or pending
reply. The built-in harness continues the existing transcript with its normally
allowed tools, so it can finish work such as controlling a background `exec`
process. This continuation preserves completed actions and uses the same retry
budget. Partial answers and intentional silent cron results keep their existing
handling; a confirmed context overflow still uses compaction.

Auto-compaction emits `compaction` stream events and can trigger a retry. On retry, in-memory buffers and tool summaries reset to avoid duplicate output. See [Compaction](/concepts/compaction).

## Event streams

- `lifecycle`: emitted by `subscribeEmbeddedAgentSession` (and as a fallback by `agentCommand`).
- `assistant`: streamed deltas from the agent runtime.
- `tool`: streamed tool events from the agent runtime.

After a definitive lifecycle `end` or `error` is published, the event owner
suppresses later client lifecycle events for that execution, including model updates
and duplicate terminals during abort cleanup. Retryable attempt errors leave
the lifecycle open. Chat abort keeps its immediate terminal with `aborted: true`
and the caller's stop reason (for example `rpc`, `restart`, or `timeout`).
The abort owner reserves that terminal before invoking cancellation listeners.
The same publication decision covers agent frames, chat finals, progress snapshots,
and session lifecycle notifications. Execution settlement and cleanup continue
independently of event publication.

Transport lease cleanup after connection recovery is best effort. Disposal errors
are logged without changing the turn result, and cleanup waits use the existing
agent cleanup budget (10 seconds by default). A discarded refresh candidate's
cleanup failure leaves the previous transport available for the retry. A timeout
does not certify that the underlying resources have closed.

For completed `chat.send` turns, clients may request compaction, fork, or rewind
as soon as they receive chat `final`. These requests join the published turn's
remaining transcript and admission cleanup before mutating the session. A
competing live turn still returns an active-run error.
Lifecycle delivery captures registrations before listeners run, and later chat
terminal publication keeps the producer's original registration. Reusing a run ID
during a listener callback cannot make its replacement terminal.

The Gateway projects lifecycle and tool start/terminal events into the bounded,
metadata-only [audit ledger](/cli/audit). This projection records provenance and
result codes without copying prompts, messages, tool arguments, tool results,
or raw errors out of the transcript/runtime path.

## Chat channel handling

Assistant deltas buffer into chat `delta` messages. Terminal lifecycle events
produce chat `final`, `error`, or `aborted` messages. Definitive cancellation and
timeout events finalize immediately, including when the runtime reports them as
`phase: "error"`. Retryable errors keep a 15-second grace window for a fallback
or restart of the same run. Once the outer execution owner has finished its
attempts, it publishes `executionSettled: true`. The Gateway consumes that fact
without retry grace, including preparation failures that never reached a model
or emitted a fallback step. For Gateway RPC runs, `agent.wait` also joins terminal
replay publication after required settlement. Unmarked timeout and bare-abort observations
retain their existing wait-layer retry handling.

Cron attempt completions remain `finishing` across model fallbacks and
interim-acknowledgment retries; worker `finishing` events do not claim execution
settlement. Completed execution facts are captured before cron bookkeeping, but
finality is published only after execution settles. A new attempt clears the
prior outcome before preparation. Later workflow errors or aborts cannot
reclassify completed execution; cron persistence, delivery, and yielded-parent
continuation retain their separate outcomes.

A yielded end while the parent task is waiting does not commit a terminal outcome.
If dispatch then fails, the Gateway still publishes and retains that failure for
chat replay and conversation history.

Chat errors wait for terminal session persistence, including any failure notice,
so an immediate history reload includes the recorded failure. Successful and
aborted chat terminals do not wait for this write. If persistence fails, the
Gateway logs the write failure and still delivers the live chat error.

History keeps a run active while its terminal session write is pending. Once
that write succeeds, history and session activity show the recorded end time
and duration without waiting for retry grace.

Live snapshots are scoped to their assistant message. A correction can shorten or clear the current preview without erasing earlier messages. Pending text is flushed before the terminal event; pacing live updates does not delay tool execution or transcript writes.

Run-duration metadata belongs to the current run, including when preparation fails before the model starts. In Control UI completed-work rollups, independent sends have separate elapsed-time boundaries: a failed turn and the idle time before the next send are not part of that next turn's work. Steering remains associated with its target run rather than being treated as an independent retry.

## Timeouts

When no result is available before an `agent.wait` deadline, the response contains
only `runId` and `status: "timeout"`.
It does not cancel the run or identify its execution phase; wait on the same
`runId` again to observe completion. A wait interrupted by Gateway lifecycle
shutdown includes `timeoutPhase: "gateway_draining"` without terminal metadata.
Known queued chat turns report `status: "pending"`, `timeoutPhase: "queue"`, and
`providerStarted: false`.

| Timeout                                          | Default                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent.wait`                                     | 30s                                    | Wait-only; `timeoutMs` param overrides. Does not stop the underlying run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Agent runtime (`agents.defaults.timeoutSeconds`) | 172800s (48h)                          | Elapsed execution budget for each model attempt. Each configured fallback receives a fresh budget, so the total run can exceed this setting. Progress does not reset an attempt's budget. Set `0` for unlimited execution; runtime-owned provider liveness still applies. Codex enforces this budget per attempt, independently of its native stream recovery.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| CLI backend no-output watchdog                   | computed per fresh/resumed CLI run     | Separate from the agent runtime and owned by the registered backend plugin. A CLI-internal background task shares the parent subprocess and does not outlive its model attempt's timeout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Cron isolated agent turn                         | owned by cron                          | The scheduler starts its own timer when execution begins, independently of per-attempt model budgets. Fallback does not reset it. It aborts the run at the configured deadline, then runs bounded cleanup before recording the timeout so a stale child session cannot keep the lane stuck.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Model idle timeout                               | Cloud 120s; self-hosted 300s           | OpenClaw aborts a model request when no response chunks or recognized SSE comment keepalives arrive before the idle window. A separate model-progress deadline is 2x the idle window: OpenAI-compatible Completions and Responses comment keepalives, like content-free Completions chunks, keep the connection alive but do not count as progress. `models.providers.<id>.timeoutSeconds` extends this idle watchdog for slow local/self-hosted providers, but stays bounded by any lower finite `agents.defaults.timeoutSeconds` or run-specific timeout, since those bound each model attempt. Unlimited attempt budgets still keep the provider-class idle watchdog. Cron-triggered cloud model runs with no explicit model/agent timeout use the same default; with an explicit cron run timeout, cloud model stream stalls cap at 60s so configured model fallbacks can still run before the outer cron deadline. Cron-triggered runs on genuinely local endpoints (loopback/private baseUrl) keep the local idle opt-out; self-hosted providers on network baseUrls get the 300s implicit watchdog. With an explicit cron run timeout, local/self-hosted stalls cap at that timeout. Set `models.providers.<id>.timeoutSeconds` for slow local providers. |
| Provider HTTP request timeout                    | `models.providers.<id>.timeoutSeconds` | Covers connect, headers, body, SDK request timeout, guarded-fetch abort handling, and the model stream idle watchdog for that provider. Use for slow local/self-hosted providers (for example Ollama) before raising the agent runtime's per-attempt timeout; keep the agent/runtime timeout at least as high when the model request needs to run longer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

For Chat Completions streams, repeated or decreasing usage snapshots keep the
connection active but do not reset the model-progress deadline. Only advancing
prompt, completion, total, or reasoning token counts count as usage progress;
changing billing metadata does not keep a stalled request alive.

The built-in OpenClaw harness publishes the current model attempt's execution
deadline to the queue. When an attempt times out, configured fallback can start
with a fresh budget after the interrupted attempt settles. User cancellation
stops the entire run, including fallback. Approval waits pause the unused attempt
budget; resolving all pending approvals resumes that same budget. Compaction can
receive one bounded grace period. A question from `ask_user` does not pause the
attempt's execution budget. With `0`, no execution timer is armed, but provider
liveness, Stop, and bounded abort cleanup
still apply. Isolated post-tool finalization gets its own deadline and cancellation
controls rather than inheriting callbacks from the completed attempt.

A terminal timeout is a failed turn, not a successful completion. Chat and
command results retain its timeout explanation; earlier tool errors do not
replace that explanation or restart an already-final timed-out turn.
This includes a timeout during tool execution when no final payload or accepted
continuation remains. A compaction failure label does not turn that unfinished
tool timeout into a paused run; completed tool results remain in the transcript.
Earlier tool warnings and reasoning output do not count as a completed reply.
Quiet or collect-mode children do not suppress a timeout unless another
continuation owns the reply; accepting a child alone does not promise delivery.
Progress sends and messages to another conversation do not finish the current
source reply. Deliberate yields retain their existing accepted-work semantics.
Tool media stays in the result alongside the timeout; artifacts alone do not finish the reply.

Cancellation revokes the run's tool and approval authority immediately. Its
accepted terminal bookkeeping still settles through the lifecycle owner, so
Stop and restart cancellation can record the session outcome and any applicable
failure notice. A replaced session, runtime candidate, or Gateway lifecycle
cannot reuse that terminal writer.
The lifecycle owner retires the terminal writer after its accepted writes settle.

The model idle and provider HTTP rows describe the built-in OpenClaw model
path. Codex owns its native stream deadlines and network retries. After exact
native terminal receipt, OpenClaw allows two minutes for local settlement.
After separately bounded abort cleanup, queued projection gets a five-second
drain grace. Neither window resets on progress. These cleanup limits still
apply when the execution budget is unlimited. See
[Codex timeouts](/plugins/codex-harness-reference#timeouts).

Harness cleanup flushes trajectory events accepted before foreground work ended,
including during restart cancellation. It cannot accept new events after that
lifetime ends, or flush through a closed host, revoked admission, replaced run,
or replaced recorder.

When a runtime reports a definitive timeout, the Gateway records its terminal
status and error for the session sidebar immediately, without waiting for
provider retry grace. Opening the failed session dismisses its sidebar attention
as usual. A later successful turn clears the previous error and is not replaced
by an older delayed failure.

### Stuck session diagnostics

With diagnostics enabled, a built-in two-minute threshold classifies long `processing` sessions with no observed reply, tool, status, block, or ACP progress:

- Active embedded runs, model calls, and tool calls report as `session.long_running`. Owned silent model calls stay `session.long_running` until the abort threshold so slow or non-streaming providers are not flagged as stalled too early.
- Active work with no recent progress reports as `session.stalled`. Owned model calls switch to `session.stalled` at or after the abort threshold; ownerless stale model/tool activity is not hidden as long-running.
- `session.stuck` is reserved for recoverable stale session bookkeeping, including idle queued sessions with stale ownerless model/tool activity.

The controller watchdog runs even when diagnostics are disabled. Its semantic-stall threshold is at least 5 minutes and 3x the warning threshold; actual execution deadlines and registered human-input, capacity, tool, and retry waits remain distinct. It requests Stop on the exact operation, while frozen finalization uses outcome-preserving cleanup. Diagnostics only project these facts: they do not reset lanes or force an owner idle. Failed cleanup remains visibly blocked and retains writer custody until actual settlement.

Pending Code Mode `exec` and `wait` calls remain active tool work until they
settle, including `awaitResults: true` calls waiting for nested work. Nested tool
completion does not retire the outer call. The normal blocked-tool recovery
allowance and enforced run/tool deadlines still apply; after the outer call
settles, an embedded run that stops making progress remains recoverable.

Attention and recovery log lines read optional session context only when their
log level is enabled. Transcript enrichment runs in the background read worker
and returns at most 140 characters; it never delays classification or recovery.
Session replacement discards pending enrichment, and stopping diagnostics retires
pending log publications. Incognito replies remain excluded.

Pending human-input questions protect their exact active owner from stale-work
recovery. If checking a question expires it, or diagnostic reporting resumes or
replaces the run, that observation cannot authorize an abort of the resumed work.
Recovery revalidates the session generation captured with the observation.

A current Codex attempt waiting on native work is the exception to these idle
thresholds: it remains `session.long_running` with reason `runtime_owned_wait`
and is not aborted or taken over merely because it is quiet. Recovery and
steering revalidate that exact active owner and its execution budget. This does
not protect expired OpenClaw-owned requests or tools, cancellation, terminal
settlement, or ownerless state.

## Where things can end early

- Agent timeout (abort)
- AbortSignal (cancel)
- Gateway disconnect or RPC timeout
- `agent.wait` timeout (wait-only, does not stop the agent)

## Related

- [Session controller](/concepts/session-controller) - scheduling ownership and lifecycle invariants
- [Tools](/tools) - available agent tools
- [Hooks](/automation/hooks) - event-driven scripts triggered by agent lifecycle events
- [Compaction](/concepts/compaction) - how long conversations are summarized
- [Exec Approvals](/tools/exec-approvals) - approval gates for shell commands
- [Thinking](/tools/thinking) - thinking/reasoning level configuration
- [Agent runtimes](/concepts/agent-runtimes) - alternate harness runtimes that drive this loop
