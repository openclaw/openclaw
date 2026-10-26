---
doc-schema-version: 1
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
After the transcript append, pass its committed message, anchor, and actual
`{ appended }` result to `userTurnTranscriptRecorder.markRuntimePersisted(...)`.
Only `appended: true` can trigger an original-input commit notification; a
duplicate history match must report `false`.

Store native bindings in plugin state. Implement `reset(...)` for an in-place
session reset and `withSessionDeletion(params, run)` for removal of a session
key, including expiry and maintenance. A physical session ID changing at the
same key is a transfer, not deletion; preserve any compaction adoption path.

Core logs reset-hook failures once per harness ID per process, including across
plugin reloads. Later resets still invoke the hook so it can recover.

ACPX automatically migrates sessions from its former `<workspace>/state` default
to `<OPENCLAW_STATE_DIR>/acpx` when the new default is empty. Set
`plugins.entries.acpx.config.stateDir` only to keep a different location; explicit
values are never relocated. Failed adoption warns and retains the old location
for the process so an update does not silently hide existing sessions.

`withSessionDeletion` acquires the native owner's lease before invoking `run`.
For stored native bindings, use `createNativeSessionBindingLifecycleV2` so core
can commit deletion and rollback through its worker participant. Use
`createNativeSessionCommitFinalizer` for effects that only run after commit.
Opaque `run({ commit, rollback })` callbacks remain deprecated compatibility:
for durable Gateway deletion, core invokes `commit()` only after the worker
acknowledges the session commit and does not call `rollback()` for a failed
database write. Legacy cleanup failures warn without undoing deletion; cleanup
must tolerate an absent session and be safe to retry after a process exit.
Stopped-owner maintenance and process-local incognito deletion retain their
native transaction contract. Keep asynchronous subscription cleanup after `run`;
do not restore bindings after the session transaction committed. See
[deletion companions](/plugins/sdk-migration/compatibility-policy#harness-deletion-companions).

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

### Native child observations

Implement optional `readNativeSubagents(params)` to expose native children in the
Control UI Subagents panel. An authorized `sessions.describe` read opts in with
`includeNativeSubagents: true`. Core captures registered observers and rechecks
the parent session, sharing access, and plugin lifetime before returning results.
A parent's runtime selection does not discard children retained by an earlier runtime.

Return `coverage: "live"`, at most 128 children (`id`, `label`, and observed
`status`), and `truncated`. Revalidate `params.assertCurrent()` after awaited
work. Bind observations to the exact physical parent and native connection;
never discover, adopt, start, resume, or retain execution just for inspection.
Return `undefined` when the observation owner is unavailable. Native IDs are
opaque display identities, not session keys or cancellation handles. Completed
observations may disappear when their native owner retires; this is not saved
history or proof that a parent consumed the child's result.

### Fresh native thread seeds

The optional `hostCapabilities.prepareBoundedSeed({ assertCurrent, signal, tokenBudget })`
returns a readonly `AgentMessage[]`. Call it after native reuse fails, before
injecting history; older version-1 hosts keep their bounded selection.
The host captures the target, configuration, source authority, and atomic
summary persistence. It attempts one compaction for uncovered omitted history.
Pass the final history allowance as `tokenBudget`: valid smaller values narrow
the captured budget; larger, invalid, or non-finite values cannot widen it.
Restored text and image costs count toward the bound. Reuse returned message
instances with `prepareContextMedia` to avoid rereading their prepared snapshots.
Active requests and refresh handoffs reserve delivery tokens but are not trimmed
by the historical byte cap; preparation rejects if they alone exceed the allowance.
Pass the native binding's current-authority assertion and cancellation signal.
A retired capability rejects and cannot target another session. Explicit
context engines retain their own projections.

## Shared native binding lifecycle

Official harnesses use the JavaScript-only private
`openclaw/plugin-sdk/agent-harness-session-runtime`; it is not a third-party
Plugin SDK contract. Binding mutations use action-bound plugin-state observations
and conditional writes in the shared-state worker. Durable bundled session
deletion and conditional rollback settle in the executing agent worker.
Final native lease assertions stay synchronous; opaque
released deletion callbacks, incognito sessions, and message-cut transactions
keep their existing native ownership.
`createNativeSessionBindingLifecycleV2` owns exact-token lease acquisition,
renewal, mutation fences, and transactional deletion/rollback. The backend
supplies `NativeSessionBindingStateStoreV2` over the same plugin-state namespace,
including awaited `lookup`, action-bound `withCurrent`, and the synchronous
effect guard `assertLeaseCurrent`. Supply its `workerCodec`, record codec,
acquisition/retention policy, errors, and timing. The old
`createNativeSessionBindingLifecycle` and its synchronous store view remain
deprecated compatibility through 2026-12-31, with removal in the first January
2027 stable release.
Pass host authority through `assertCurrent` and validate the expected generation
in `assertRecordCurrent`. Leases coordinate storage; they grant no execution
authority. Keep native cleanup after the host transaction commits.

Inside `withLease`, call `captureLeaseAssertion(key)` to capture the exact owner
and recheck its live, unexpired lease before native requests or transcript writes.
Combine it with host authority for normal work. Cleanup may use retained lease
ownership after host retirement, but must reject an expired, replaced, or closed
lease even while the harness remains alive.

Await `retainNativeSessionGenerationAuthority`,
`reclaimNativeSessionGenerationWithAuthority`, and
`resolvePreparedNativeSessionBinding` to preserve the host generation and
predecessor across waits, adopting a verified predecessor before stale
reclamation. The prepared resolver awaits `readBinding` and returns
`{ binding, authority, release }`. Release the capture in `finally` after terminal
cleanup; `authority.withLiveness` borrows that capture for cleanup with its own
lifecycle check. A missing host entry permits an ephemeral session; a
failed read cannot authorize a binding. The older generation helpers and the
released `resolveNativeSessionBindingWithAuthority` retain synchronous binding
reads only for compatibility; see the
[generation authority migration](/plugins/sdk-migration/compatibility-policy#native-session-generation-authority).

`createNativeSessionInitializationOwner` associates binding and upstream-link
writes with the exact host creation handle. Rollback requires the matching
store, identity, binding, and live authority, removes only the exact upstream
link, then invokes backend cleanup. Queue selection, native protocol/policy,
and resource cleanup remain with the backend; core owns host session lifecycle.

## Tool and media results

### Same-turn retry context

The optional `params.continuation` carries host-owned recovery context when a
transient failure retries the same task. Its `prompt` is the original current
request; its `messages` contains settled attempt snapshots in order, including
completed assistant/tool messages and tool results. Keep the request visible
outside bounded history projections and retain completed tool evidence when
rendering the snapshots. These facts describe completed work; they do not grant
execution authority or ask the harness to execute those tools again.

Codex consumes this carrier even when the admission-fenced transcript ends
before the current request, using its existing bounded context projection.
The continuation instruction stays model-only and is not persisted as another
user turn. Harnesses that ignore the optional field retain their existing
transcript-based recovery behavior.

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

Pass tool arguments unchanged to execution and event consumers; the former
`sanitizeToolArgs` export has been removed. Use `sanitizeToolResult` for result
presentation and its shared size and image-storage rules. It does not mask
secrets. Secret masking belongs at logging and diagnostic export boundaries;
`logging.redactPatterns` does not apply to tool or transcript content.

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

## Harness delivery defaults

Set `deliveryDefaults.visibleReplies` to `"automatic"` or `"message_tool"`
when a harness needs a default visible-reply policy. Explicit message config
still takes precedence.

The deprecated `sourceVisibleReplies` field remains supported for published
harness plugins, including July 2026 versions of `@openclaw/codex`. When both
fields are present, `visibleReplies` takes precedence. Plugin authors should
migrate to that field. The October 1 removal date does not retire a contract
while supported published plugins still produce it.

## Terminal tool outcomes

`AgentHarnessAttemptParams.observeToolTerminal` is the host-owned terminal
outcome accumulator. A harness that executes OpenClaw dynamic tools or native
tools must call it when each tool reaches one terminal outcome, before the
attempt result is finalized. Harnesses that do not execute tools do not need to
call it.

Report facts from the execution boundary:

- Pass the protocol call id when one exists, the standard tool name, and the
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

The callback returns the recorded resolution for that call. Carry its
`lastToolError` into `AgentHarnessAttemptResult` and use its execution,
arguments, and side-effect facts in the harness projection instead of deriving
parallel state. The host keeps an unresolved mutating failure across unrelated
successful tools and clears it only after the matching action succeeds.

The callback remains optional for source compatibility with older experimental
harnesses. Optional does not mean ignorable for a harness that executes tools:
without terminal reports, OpenClaw cannot preserve mutating-tool failure truth
across later tool calls, including intentionally silent automation completion.

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
- refuse to run if its selected transcript/isolation strategy cannot enforce
  those restrictions.

OpenClaw invokes the callback once as a terminal sub-operation, outside the
ordinary attempt and retry loop. A failure ends the run with the
side-effect-aware incomplete-turn warning; it cannot enter ordinary
auth/profile rotation, model fallback, context recovery, compaction
continuation, or hook-requested revision paths. Finalization also skips plugin
prompt mutation, `before_agent_run`, LLM input/output, terminal revision, and
`agent_end` hooks. Core diagnostics still record the operation and its failure.

When the settled turn stopped at the model's output token limit, the
finalization prompt tells the model it was cut off and must say what was not
finished. OpenClaw also adds a host notice under the recovered answer saying
that the turn was cut off and some work may be unfinished, because a tool-free
summary cannot show that the interrupted work completed.

An answered finalizer after a non-visible `length` stop preserves that original
stop reason in terminal and completion metadata and records an `incomplete_turn`
failure. The summary and notice remain deliverable, while CLI exits, HTTP/ACP
results, channel reactions, session status, and scheduled tasks reflect the
incomplete work. A tool-free answer provides a summary without proving task completion.
Summary recovery after a normally completed turn remains successful.

The callback returns `AgentHarnessSettledTurnFinalizationResult`, not an
ordinary attempt result. Its public fields are limited to the completed
assistant message, finalization-call usage, transcript-ownership metadata, and
diagnostic trace. Tool, delivery, media, spawn, lifecycle, replay, session, and
fallback state cannot cross this result boundary. Unknown fields and assistant
tool calls are rejected.

A harness that internally reuses its full attempt engine can call
`projectSettledTurnFinalizationAttemptResult(...)` before returning. The helper
rejects recorded failure, tool, delivery, replay, and lifecycle evidence, then
projects only the narrow result. It is defense in depth after native isolation,
not a substitute for removing the native capability surface.

A projection-backed harness must capture the active branch after the settled
turn is mirrored and prove that the current prompt and every current tool
call/result are present through that boundary. A turn whose prompt was never
persisted (an internal system turn with `suppressNextUserMessagePersistence`
and no `userTurnTranscriptRecorder`) has no prompt row to prove; its evidence
starts at the turn's first mirrored row. Put the frozen evidence on
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

A harness can defer projection acquisition with the optional
`attempt.onSettledTurn(settledAttempt, captureContext)` callback. Await it after
mirroring the settled result and before releasing the attempt's binding or model
authority. Core uses its reply-delivery facts and finalization policy to decide
whether to call `captureContext`; a delivered reply does not need a projection.
The capture function returns the same context union described above. Core stores
that result on `settledAttempt.settledTurnFinalizationContext` for the later,
tool-free finalization operation. An eligible attempt may initially mark the
context `source: "unavailable"`; this records eligibility without reading history.

The callback shares the attempt's revocable host capability scope. Calls after
the attempt closes, aborts, or loses its admitted lifecycle are rejected before
core observes delivery or changes the result. Context capture that finishes
after revocation is also rejected before its result is stored.

The capture function belongs only to this awaited callback. It must check the
original attempt's live binding and model authority, honor cancellation, and
finish identity and source-evidence verification before returning frozen,
detached context. Do not retain the function beyond the callback, put deferred
work in `data`, or reuse released authority. Harnesses that omit this callback
keep supplying context before returning their attempt, as before.

Existing code that removes `hostCapabilities` from an attempt remains compatible
with the finalization parameter type. Core removes `onSettledTurn` when preparing
the isolated finalization parameters; it is not a finalization capability.

Enforce projection limits while acquiring messages, rather than cloning the
whole transcript before checking its size. Do not retain an open transcript
reader in `data`. The finalizer must reject a missing,
unsupported, ambiguous, or oversized context. It must not truncate messages,
drop earlier history, or describe an application projection as exact native
history. Harnesses that resume one restricted native session do not need this
projection field.

Do not implement `finalizeSettledTurn` by calling `runAttempt` with a best-effort
`disableTools` hint. The harness owner must enforce the complete native
capability boundary. OpenClaw does not provide a generic fallback because it
cannot attest that an arbitrary native runtime honored those restrictions.

`finalizeSettledTurn` remains optional for experimental third-party harness
compatibility. When the selected harness omits it, OpenClaw preserves the
existing incomplete-turn error instead of risking repeated side effects.
