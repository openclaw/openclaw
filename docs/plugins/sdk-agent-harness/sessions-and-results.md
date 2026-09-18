---
summary: "Native session bindings, the OpenClaw transcript mirror, tool and media result delivery, terminal tool outcomes, and settled-turn finalization"
read_when:
  - You are storing a native session, thread, or resume token
  - You are returning tool, media, or terminal-outcome results
  - You are implementing `finalizeSettledTurn`
title: "Agent harness sessions and results"
sidebarTitle: "Sessions and results"
---

How a native session binds to an OpenClaw session and mirrors into its transcript, and how tool, media, terminal-outcome, and settled-turn results come back through the attempt result. Part of the [Agent harness plugins](/plugins/sdk-agent-harness) reference.

## Native sessions and transcript mirror

A harness may keep a native session id, thread id, or daemon-side resume
token. Keep that binding explicitly associated with the OpenClaw session, and
keep mirroring user-visible assistant/tool output into the OpenClaw
transcript.

The OpenClaw transcript remains the compatibility layer for:

- channel-visible session history
- transcript search and indexing
- switching back to the built-in OpenClaw harness on a later turn
- generic `/new`, `/reset`, and session deletion behavior

For user-message mirrors, use
`restorePreparedUserTurnOperationalMetaForRuntime({ runtimeMessage, preparedMessage })`
from `openclaw/plugin-sdk/agent-harness-runtime`. Pass an independent, trusted
snapshot of the host-prepared input as `preparedMessage`. Clone `content` and
selected-mention metadata before hooks that can mutate them in place, and keep
that snapshot unchanged.

The helper restores operational metadata on user messages without replacing
native or hook-rewritten content. Non-user runtime messages are returned unchanged.
Human mentions survive only when the entire `content` value exactly matches the
prepared snapshot; changed text must not inherit the old selections.

Restored metadata neither authorizes actions nor proves a fresh transcript append.
After the canonical append, pass its committed message, anchor, and actual
`{ appended }` result to `userTurnTranscriptRecorder.markRuntimePersisted(...)`.
Only `appended: true` can trigger an original-input commit notification; an
idempotent history match must report `false`.

Store native bindings in plugin state. Implement `reset(...)` for an in-place
session reset and `withSessionDeletion(params, run)` for removal of a session
key, including expiry and maintenance. A physical session ID changing at the
same key is a transfer, not deletion; preserve any compaction adoption path.

`withSessionDeletion` acquires the native owner's lease before calling
`run({ commit, rollback })`. Core invokes the synchronous `commit()` at the
session row deletion boundary and `rollback()` if the transaction fails.
Rollback must also tolerate a failed or unapplied commit. Keep asynchronous
subscription cleanup after `run` so it does not hold the SQLite writer queue;
do not restore bindings for errors after the session transaction committed.

Recheck `params.assertCurrent()` after awaited work and immediately before
mutating native state. The callback belongs to one registered harness lifetime;
retaining it after the operation closes does not retain authority. Post-delete
hooks are notifications, not the owner of durable binding removal.

Implement `withSessionContextReset(params, run)` when a native binding must be
invalidated by a successful same-key rewind or branch switch. This optional hook
uses the same prepared `commit`/`rollback` contract, but keeps the session key and
retained history. Core commits invalidation only after validating the requested
cut and restores it if the transcript transaction fails. Release subscriptions
after the committed mutation settles. The optional `previousSessionId` is the
recorded predecessor, allowing retirement of a binding not yet transferred after
compaction without adopting it during preparation. Ordinary compaction does not
invoke this hook and continues to preserve native thread continuity.

## Subagent task history

Native subagents can expose the shared task transcript view through the optional
`taskHistory` harness capability. Declare the owned `taskKinds` and implement
`read({ task, cfg, cursor, limit, assertCurrent })`. Return chronological chat
`messages` with a stable `messageId` (or canonical `__openclaw.id`) and an optional
`nextCursor` for older history. Internal runtime-only IDs are insufficient: the
shared viewer must recognize the identity across pages and refreshes. Rows that
share a transcript entry ID remain one display group.
Preserve typed thinking, tool-call, and tool-result content so the normal chat
renderer can display it. Bound native reads and response sizes.

The Gateway's `tasks.history` method authorizes the task's requester session and
routes history to its existing OpenClaw child session or the owning harness.
It accepts a task ID, an optional opaque cursor, and a limit from 1 to 200
(default 100). The harness must verify native parent/child lineage and the
bound connection, and call `assertCurrent()` after awaited work. The Gateway
rechecks access before returning a page and caps the response at 4 MiB.

Record immutable native history routing facts in task detail when creating the
task. A later parent turn can replace its current native thread without changing
the child's source. Preserve the original parent and connection identity across
progress, completion, and recovery; never reconstruct them from a replacement
binding. Preserve authorized compaction transfers within the same session
lifecycle, while rejecting resets and account or connection changes.
Runtime task detail participates in the Gateway's cursor and
after-await identity checks.

Keep `childSessionKey` absent for native children: it describes an OpenClaw
session and also determines lifecycle ownership. Reading history must not adopt
the child, create another transcript store, or change cancellation and recovery.
`TaskSummary.hasTranscript` advertises readable history to the shared viewer.

## Tool and media results

`inferToolMetaFromArgs` from `openclaw/plugin-sdk/agent-harness-runtime` returns
compact, lossy display metadata. Array values deeper than 64 levels are omitted;
shallower siblings still contribute to the preview. The helper can return
`undefined`. Keep the original arguments for validation and execution: display
metadata is neither an argument replacement nor a general-purpose traversal limit.

Core constructs the OpenClaw tool list and passes it into the prepared
attempt. When a harness executes a dynamic tool call, return the tool result
back through the harness result shape instead of sending channel media
yourself.

This keeps text, image, video, music, TTS, approval, and messaging-tool
outputs on the same delivery path as OpenClaw-backed runs.

For messaging tools, read the original result's `details.messageDelivery` with
`readEmbeddedMessageDeliveryFact` from `openclaw/plugin-sdk/agent-harness-runtime`.
Only settled delivery counts as a sent message; successful dry runs and suppressed
sends must not suppress a later reply. Preserve partial delivery evidence when a
tool also reports an error. Messaging tool results without a delivery fact use
`isDeliveredMessagingToolResult`, which owns tool eligibility and receipt interpretation.
For core conversation tools, it reads the original Gateway result's `details.status`:
`sent` confirms delivery, as do `replied` and `timeout` for `conversations_turn`.
A peer-reply timeout or correlation error does not undo the channel send or change
the tool's error status. `queued`, `suppressed`, and `unknown` do not confirm delivery,
even when they include a prepared message ID. Session coordination results are not
external delivery receipts.
Use `requirePluginDeliveryId: true` when legacy plugin results need a concrete
message ID; authoritative core conversation statuses do not require one.
`projectPluginMessageDeliveryFact` reads legacy result envelopes into the shared
delivery shape, retaining partial-delivery status for attachment handling.
For legacy message sends, an error takes precedence over a message ID unless
the result confirms partial delivery.
Use `isDeliveredMessagingToolSendToCurrentSource` for source-route comparisons and
`extractMessagingToolSourceReplyPayload` to retain attachment metadata and the
transcript owner's confirmation. Presentation middleware cannot establish new
delivery facts.

The same runtime entrypoint exports `sanitizeToolArgs` for diagnostic tool
arguments and event payloads. It redacts nested fields without mutating the input
and preserves own JSON keys, including `__proto__`; repeated references become
`"[Circular]"`. Use `sanitizeToolResult` for result presentation, which also applies
the shared result-size and image-storage rules.

For successful `sessions_spawn` results, use `normalizeAcceptedSessionSpawnResult`
from `openclaw/plugin-sdk/agent-harness-tool-runtime` and retain its
`AcceptedSessionSpawn` in the attempt's `acceptedSessionSpawns`. Capture the
original result before middleware changes its details. Preserve
`expectsCompletionMessage`: core needs that fact to transfer child completion
delivery when the requester yields. The helper returns `null` for an unaccepted
or incomplete receipt and treats missing completion intent as `false`.

Set `AgentHarnessAttemptResult.hostOwnedToolMediaUrls` only for native artifacts
that the trusted harness runtime created and persisted itself. Every entry must
also appear in `toolMediaUrls`. Never include model-selected dynamic-tool or
OpenClaw-tool media. On `message_tool_only` routes, this narrow provenance lets
native runtime artifacts survive source-reply suppression; normal send policy
and ambient-room admission still apply.

## Terminal tool outcomes

`AgentHarnessAttemptParams.observeToolTerminal` is the host-owned terminal
outcome accumulator. A harness that executes OpenClaw dynamic tools or native
tools must call it when each tool reaches one terminal outcome, before the
attempt result is finalized. Harnesses that do not execute tools do not need to
call it.

Report facts from the execution boundary:

- Pass the protocol call id when one exists, the canonical tool name, and the
  arguments that actually reached the tool after preparation or hook rewrites.
- Pass the original host tool result or thrown error as `result`. Core reads
  private effect provenance from that object; serialized fields cannot provide
  this proof. Preserve internal result state when projecting a host result.
- Set `executionStarted: false` when validation, approval, or another guard
  stopped the call before the tool implementation began. Once dispatch may
  have happened, report `true` conservatively.
- Report `outcome: "success"` or `outcome: "failure"`. Include the structured
  failure fields available from the runtime instead of inferring failure from
  display text.
- Use `nativeMutation` only for native tools that do not use an OpenClaw tool
  definition. Supply protocol-owned mutation and replay facts there; do not
  copy OpenClaw's mutation classifier into the harness.

The callback returns the canonical resolution for that call. Carry its
`lastToolError` into `AgentHarnessAttemptResult` and use its execution,
arguments, and side-effect facts in the harness projection instead of deriving
parallel state. The host keeps an unresolved mutating failure across unrelated
successful tools and clears it only after the matching action succeeds.

The callback remains optional for source compatibility with older experimental
harnesses. Optional does not mean ignorable for a harness that executes tools:
without terminal reports, OpenClaw cannot preserve mutating-tool failure truth
across later tool calls, including quiet heartbeat completion.

## Settled tool finalization

OpenClaw may need one final visible answer after a harness has completed every
tool call but its native turn ended without assistant text. A harness can opt
into that recovery by implementing `finalizeSettledTurn({ attempt,
settledAttempt })`.

The callback is a separate capability, not another ordinary attempt. It must:

- use either the exact restricted native transcript or a complete application
  transcript frozen through the settled tool-result boundary;
- expose no tools, permission-grant or user-input capabilities, native execution
  hooks, agents, skills, memory, scheduling, extensions, or remote control;
- send only the host-provided finalization prompt; and
- fail closed if its selected transcript/isolation strategy cannot enforce
  those restrictions.

OpenClaw invokes the callback once as a terminal sub-operation, outside the
ordinary attempt and retry loop. A failure ends the run with the
side-effect-aware incomplete-turn warning; it cannot enter ordinary
auth/profile rotation, model fallback, context recovery, compaction
continuation, or hook-requested revision paths. Finalization also skips plugin
prompt mutation, `before_agent_run`, LLM input/output, terminal revision, and
`agent_end` hooks. Core diagnostics still record the operation and its failure.

The callback returns `AgentHarnessSettledTurnFinalizationResult`, not an
ordinary attempt result. Its public fields are limited to the completed
assistant message, finalization-call usage, transcript-ownership metadata, and
diagnostic trace. Tool, delivery, media, spawn, lifecycle, replay, session, and
fallback state cannot cross this result boundary. Unknown fields and assistant
tool calls fail closed.

A harness that internally reuses its full attempt engine can call
`projectSettledTurnFinalizationAttemptResult(...)` before returning. The helper
rejects canonical failure, tool, delivery, replay, and lifecycle evidence, then
projects only the narrow result. It is defense in depth after native isolation,
not a substitute for removing the native capability surface.

A projection-backed harness must capture the active branch after the settled
turn is mirrored and prove that the current prompt and every current tool
call/result are present through that boundary. Put the frozen evidence on
`settledAttempt.settledTurnFinalizationContext` as one of:

- `source: "openclaw-transcript"` with `messages`: the complete application
  transcript through the boundary.
- `source: "harness"` with `data`: an immutable, bounded projection interpreted
  only by the owning harness. Core passes this opaque value through; the
  finalizer must verify its own context type before using it.
- `source: "unavailable"`: the harness permits finalization for this settled
  turn, but safe replay evidence could not be captured. The finalizer must
  reject this state before provider or native I/O; core can still use its
  existing host-owned fallback without repeating tools.

The unavailable state records eligibility, not validated history. Eligible
capture failures, including missing, drifting, or oversized evidence, can reach
that no-model fallback. Do not emit it for failures the harness excludes from
finalization, such as authentication or usage-limit errors. Command-only
harnesses must retain the attributed assistant tool-call entry in
`messagesSnapshot`; the host fallback can use that settled-batch identity when
visible-assistant fields are absent.

Enforce projection limits while acquiring messages, rather than cloning the
whole transcript before checking its size. Successful capture must finish all
identity and source-evidence checks before returning the attempt. Do not retain
an open transcript reader in `data`. The finalizer must reject a missing,
unsupported, ambiguous, or oversized context. It must not truncate messages,
drop earlier history, or describe an application projection as exact native
history. Harnesses that resume one restricted native session do not need this
projection field.

Do not implement this callback by calling `runAttempt` with a best-effort
`disableTools` hint. The harness owner must enforce the complete native
capability boundary. OpenClaw does not provide a generic fallback because it
cannot attest that an arbitrary native runtime honored those restrictions.

The callback remains optional for experimental third-party harness
compatibility. When the selected harness omits it, OpenClaw preserves the
existing incomplete-turn error instead of risking repeated side effects.

## Settled quota continuation offers

`settledQuotaContinuation` on an attempt result is an optional producer-owned
**offer**, not replay authorization. Set `reason: "quota_exhausted"` only from
structural provider/runtime evidence that distinguishes exhaustion from temporary
throttling. Supply `messages` as the exact durably mirrored current user turn,
including every unique tool call and matching successful result. Never synthesize
missing results or use a best-effort history projection as settlement evidence.

The producer must exclude hidden native work and establish native quiescence,
including pending approvals, requests, asynchronous tools and hooks. Seal new request
admission before taking the settlement snapshot, join already-admitted handlers, and
bind persisted call arguments/results to immutable execution receipts. A fulfilled
best-effort cleanup promise is not proof of closure: required-resource failure or
timeout must veto the offer, including in long-lived non-one-shot runs. Failed teardown
must remove the offer while preserving the original quota error and unsafe replay
metadata. The bundled Codex implementation initially offers only audited core file
operations (`read`, `write`, `edit`, `apply_patch`) on its restricted host-tool surface,
without native shell/code-mode/MCP, managed hooks or supervision. Its private
concrete-result provenance and host effect receipt are both required. The private receipt
captures executed arguments, tool identity, and the lossless text projection immediately
after execution, before result middleware, legacy extensions, callbacks, redaction or
context budgeting. Changed or shortened evidence vetoes the optional offer; ordinary
sanitized transcript/output behavior remains enabled. Raw receipts are not logged or
persisted. Copied results,
opaque plugin/channel tools and host shell commands cannot assert synchronous settlement.

Core independently validates the whole current transcript (at most 256 messages and
512 KiB), closes the old host capabilities, and joins tracked cleanup within a bounded
handoff window. A weakly held in-process token binds the offer to the exact admitted
turn; copied/serialized result data cannot be used as that token. It is consumed once
by an OpenClaw-runtime candidate selected from the caller's configured fallback chain.
The host rechecks current authority, transcript and delivery state before consumption,
and uses an internal, non-persisted continuation prompt. Selection retains the original
remaining candidate suffix and consumed identities. The logical-turn execution/retry
remainder, including approval pauses, is carried rather than reset.

The final post-transform provider body must retain the complete admitted user/tool
prefix and its occurrence inventory. The host retains the admitted older/current-turn
boundary (at most 4,096 messages / 4 MiB for this optional inventory) and observes new
successor tool outcomes before extension callbacks; payload
hooks cannot add completion receipts. If ordinary persistence omits a non-executable
call, only the loop's observed no-start failure can supply its validation-only call
projection; executed effects still require their durable call/result pair. Older identical requests and distinct, observed
successor rounds remain valid. Normal bijective call-ID normalization is allowed, but
extra user admissions, duplicated subsets, missing or rewritten effect evidence are not.
The post-hook supported plain-data body is detached before provider-owned normalization
and validation, then frozen. That same
snapshot reaches the built-in serializer. Accessors, cycles and opaque bodies fail closed. A smaller context window cannot silently discard earlier
completed frames. This initial contract accepts only built-in transports exposing
final-payload admission for `openai-completions`, `openai-responses` (including
configured OCI-compatible routes), and `anthropic-messages`. Azure and
ChatGPT/subscription-specific Responses are not yet admitted: they require separate
final-I/O authority and serializer proof.
Custom/session transports and opaque provider items fail closed. Canonical, runtime,
legacy and layout media metadata, historical media and non-text source output are
outside the initial portable scope. CLI dispatch is not supported.
Neither `fallbackSafe` nor `replayInvalid` is relaxed. See
[Settled quota continuation](/concepts/model-failover#settled-quota-continuation).
