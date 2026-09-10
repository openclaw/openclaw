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

## Tool and media results

Core constructs the OpenClaw tool list and passes it into the prepared
attempt. When a harness executes a dynamic tool call, return the tool result
back through the harness result shape instead of sending channel media
yourself.

This keeps text, image, video, music, TTS, approval, and messaging-tool
outputs on the same delivery path as OpenClaw-backed runs.

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
