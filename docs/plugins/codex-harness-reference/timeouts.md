---
summary: "Dynamic tool timeout order, turn execution budgets, and local settlement"
read_when:
  - You need the dynamic tool timeout order
  - You are changing the turn execution budget
  - You are debugging a turn that never settles
title: "Codex timeouts and turn settlement"
sidebarTitle: "Timeouts"
---

The timeout budgets around a Codex turn, and how OpenClaw settles a completed turn. Part of the [Codex harness reference](/plugins/codex-harness-reference); [Where each section moved](/plugins/codex-harness-reference#where-each-section-moved) lists every section.

## Timeouts

OpenClaw-owned dynamic tool calls are bounded independently from
`appServer.requestTimeoutMs`. Ordinary Codex `item/tool/call` requests use the
first available timeout in this order:

- A positive per-call `timeoutMs` argument.
- For `image_generate`, `agents.defaults.mediaModels.image.timeoutMs`.
- For `image_generate` without a configured timeout, the 120 second
  image-generation default.
- For the media-understanding `view_image` tool, the selected image-capable `tools.media.models[]` entry's `timeoutSeconds`
  converted to milliseconds, or the 60 second media default. For image
  understanding, this applies to the request itself and is not reduced by
  earlier preparation work.
- For the `message` tool, a fixed 600 second outer budget that covers Gateway delivery and bounded same-key reconciliation.
- The 90 second dynamic-tool default.

This watchdog is the outer dynamic `item/tool/call` budget. Provider-specific
request timeouts run inside that call and keep their own timeout semantics.
Ordinary dynamic tool budgets are capped at 600000 ms. `agents_wait` adds 30000 ms
of outer completion grace. Human-interaction tools use the validated question
wait plus 30000 ms: `ask_user` and `secrets` credential requests honor their question
timeout, while delegated `openclaw` calls use the fixed 930000 ms default. That
budget covers the ten-minute approval window plus staging and application;
model-authored arguments cannot override it. The app-server request watchdog
leaves another 30000 ms beyond the applicable tool budget for the result to reach
Codex.

On timeout, OpenClaw aborts the tool signal where supported and returns a failed
dynamic-tool response to Codex so the turn can continue instead of leaving the
session in `processing`. These wait budgets never preserve approval authority
after the requesting run or tool closes.

### Turn execution and settlement

Native Codex owns provider-stream liveness, network recovery, and native turn
completion. For ordinary turns, OpenClaw waits for `turn/completed` with the
exact thread and turn identity, or an authoritative failure or cancellation.
Silence, completed tool output, and a completed-looking assistant message do
not prove that the turn has finished. Partial output remains available on
failure, but OpenClaw does not upgrade a timeout or lost client into success.

The existing `agents.defaults.timeoutSeconds` setting supplies one elapsed
execution budget per attempt, defaulting to 48 hours. Progress does not reset
that budget, including during long tool execution. Set it to `0`, or use a
per-run timeout of `0`, for unlimited execution. Native connection recovery
can keep retrying, so a provider-stream timeout is not a whole-turn deadline.
An unlimited native wait ends only on a native terminal outcome, an
authoritative failure, or explicit Stop. Startup, app-server control requests,
approvals, dynamic tools, and cancellation retain their independent deadlines.
`/btw` side questions retain their separate ten-minute completion budget.

On receipt of the exact native terminal event, OpenClaw starts an absolute
two-minute local-settlement budget before asynchronous transcript and media
projection. Later notifications do not reset it. Presentation callbacks start
in order and join at settlement without blocking native notification processing.
If the native turn completed successfully with a complete final answer, expiry
preserves that answer as a degraded success. OpenClaw retires unfinished
projection and stale writes, then persists the answer through the existing
transcript owner, preserving write ordering and hooks.
Recovered replies retain native network-result provenance even when the
corresponding tool projection did not settle or a message-write hook replaces
the message.

The `turn.settlement_warning` trajectory event records the pending presentation
callback, transcript/checkpoint write, or media projection stage, together with
the elapsed time and budget. Newly persisted recovered replies also carry the
settlement warning. Final persistence retains its best-effort policy and the
existing five-second drain grace; if the writer remains unavailable, OpenClaw
records `turn.settlement_persistence_unavailable` and delivers the completed
text without leaving a stale write behind. Expiry without a native completed answer remains a timeout.
After separately bounded abort cleanup, queued projection gets a five-second
drain grace. These local bounds also apply to unlimited runs.

Stop and execution-budget expiry interrupt the affected native attempt and
bound cleanup before releasing its lane. A quiet turn or a local settlement
failure does not establish that a shared app-server client is dead; unrelated
thread leases on a healthy client remain isolated. Generic stale-run recovery
also respects the exact active native owner, without exempting expired
OpenClaw requests, tools, cancellation, terminal cleanup, or ownerless state.

Replay-safe stdio app-server failures may be retried once on a fresh attempt.
Assistant, tool, active-item, or side-effect evidence can make replay unsafe;
OpenClaw then reports the failure rather than automatically rerunning the work.
Verify current state before retrying an unsafe failed turn.

The former `appServer.turnCompletionIdleTimeoutMs`,
`appServer.turnAssistantCompletionIdleTimeoutMs`, and
`appServer.postToolRawAssistantCompletionIdleTimeoutMs` settings are retired.
Run `openclaw doctor --fix` to remove them. Doctor preserves unrelated settings
and does not translate idle windows into an elapsed run budget.
