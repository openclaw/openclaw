---
summary: "Runtime helpers a selected harness calls during and after an attempt: injection, middleware, outcome classification, usage, and agent-end side effects"
read_when:
  - You are accepting steering or queued input during a live run
  - You are transforming tool results before they reach the model
  - You are reporting output tokens or running agent-end side effects
title: "Agent harness attempt runtime"
sidebarTitle: "Attempt runtime"
---

The helpers a selected harness calls while an attempt is running and as it finalizes: guarded input injection, tool-result middleware, terminal outcome classification, live token usage, and agent-end side effects. Part of the [Agent harness plugins](/plugins/sdk-agent-harness) reference.

## Guarded active-run injection

Backends that accept source-bound controls advertise `messageInjectionV2` on
their active-run handle. The capability is contextually typed by
`setActiveEmbeddedRun` from `openclaw/plugin-sdk/agent-harness-runtime`; its type
can also be derived from that function's handle parameter. It requires
`version: 2`, `isAvailable()`, and
`queueMessage(text, options, assertCurrent, authorityKind)`.
The required third argument is a host-owned assertion for that individual
injection, not a run ID, fingerprint, or diagnostic identity. The required
`authorityKind` is `"run"` for ordinary input or `"source-bound"` for input
whose source lifetime also constrains dispatch. Both retain the backing-run
check; a source-bound input must never be relabeled as ordinary input.

Invoke `assertCurrent()` alongside the backend's own live-run check after
awaited preparation and immediately before queue mutation or provider dispatch.
The host normalizes false or throwing source authority into rejection and keeps
that injection revoked even if the source later appears current again. Plugins
invoke the supplied assertion; they do not reconstruct its authority. Batched
backends retain and revalidate each item's assertion, including before retries;
omit revoked items without cancelling independently accepted work or poisoning
later authorized controls.

Optional V2 `claimPendingUserInputAnswer(text, options, assertCurrent, authorityKind)`
and `cancelPendingUserInput(resolvedBy, assertCurrent, authorityKind)` methods
require the same assertion and authority kind. Carry it through question registration and persistence to the final
claim or cancellation boundary. Do not implement V2 by checking only before
calling an SDK method that itself awaits before dispatch. If the sink cannot
enforce the assertion, leave V2 unsupported.

The V1 `messageInjection`, queue options, `queueAgentHarnessMessage`, and
`setActiveEmbeddedRun` signatures shipped in v2026.8.1 remain source-compatible.
Pass the resolved agent ID as the fifth `setActiveEmbeddedRun` argument so raw
`global` and `unknown` keys retain their owner. Legacy calls inside a matching
live host binding inherit its validated agent; an ambient caller alone does not
supply ownership. Outside that binding, omitted ownership uses the qualified
session key or the configured default agent for session activity.
Unscoped V1 injection retains its existing behavior. Source-bound controls
require V2 and reject visibly before queue or I/O when only V1 is available;
they never fall back to an unchecked V1 callback. Existing deprecation windows
are unchanged.

Copilot remains V1-only: `@github/copilot-sdk` 1.0.11 awaits trace-context and
JSON-RPC writer preparation after `send` entry without a final-dispatch guard.
Scoped steering therefore fails before its queue, question claim, or provider
I/O; ordinary unscoped injection is unchanged. Check status, cancel the run, or
start a new explicit request instead. Update the runtime when guarded injection
is supported. Once upstream supplies a final-dispatch assertion, migrate
Copilot to V2 and remove this internal V1 reliance; do not add an unchecked
fallback or shorten the shipped API's deprecation window.

## Tool-result middleware

Bundled plugins and explicitly enabled installed plugins with matching
manifest contracts can attach runtime-neutral tool-result middleware through
`api.registerAgentToolResultMiddleware(...)` when their manifest declares the
targeted runtime ids in `contracts.agentToolResultMiddleware`. This trusted
seam is for async tool-result transforms that must run before OpenClaw or
Codex feeds tool output back into the model.

Middleware options may combine `runtimes` with a `matcher` tool-name list.
Each registration keeps that pair intact, so registering the same handler for
different runtimes does not broaden either matcher. Matchers use non-empty
canonical OpenClaw tool ids; omit `matcher` to match all tools.

Legacy bundled plugins can still use
`api.registerCodexAppServerExtensionFactory(...)` for Codex app-server-only
middleware, but new result transforms should use the runtime-neutral API. The
embedded-runner-only `api.registerEmbeddedExtensionFactory(...)` hook has been
removed; embedded tool-result transforms must use runtime-neutral middleware.

Retain `details.messageDelivery.sourceReplyDelivered` from the host message tool
before middleware transforms its result, and carry it into the attempt result.
This confirms a final external source reply and does not depend on destination
arguments or transcript mirrors.

## Terminal outcome classification

Native harnesses that own their own protocol projection can use
`classifyAgentHarnessTerminalOutcome(...)` from
`openclaw/plugin-sdk/agent-harness-runtime` when a completed turn produced no
visible assistant text. The helper returns `empty`, `reasoning-only`, or
`planning-only` so OpenClaw's fallback policy can decide whether to retry on a
different model. `planning-only` requires the harness's explicit `planText`
field; OpenClaw does not infer it from assistant prose. The helper
intentionally leaves prompt errors, in-flight turns, and intentional silent
replies such as `NO_REPLY` unclassified.

## Live output-token usage

Call `params.hostCapabilities.reportOutputTokens?.(outputTokens)` once per
completed model response. Pass that response's output tokens, not a
thread-lifetime or cumulative attempt total. Deduplicate native response
notifications before calling it.

The host binds this callback to the admitted run, adds the response to its
lifecycle-scoped total, and publishes the cumulative `usage` event globally and
through `params.onAgentEvent`. Do not emit a second usage event. Retries share
the same run total; run cleanup releases it. A closed or superseded capability
rejects reporting. Invalid or nonpositive counts do not emit an event.

The capability is optional for compatibility with older hosts; when absent,
live output-token reporting is unavailable. Keep last-response context
snapshots and persisted billing usage separate from this live counter.

## Agent-end side effects

Native harnesses must call `runAgentEndSideEffects(...)` from
`openclaw/plugin-sdk/agent-harness-runtime` after they finalize an attempt. It
dispatches the portable `agent_end` hook and OpenClaw's research capture
without delaying interactive replies. Use `awaitAgentEndSideEffects(...)` for
local, non-interactive runs where the attempt must not resolve until those
side effects finish. Both helpers accept the same `{ event, ctx }` payload as
`runAgentHarnessAgentEndHook(...)`; their failures do not alter the completed
attempt result.

Pass `ctx.foregroundPromptContext` built with
`buildEmbeddedForegroundPromptContext(params, agentDir)` from the same
`EmbeddedRunAttemptParams` the attempt ran with. The detached Skill Workshop
experience review rebuilds its system prompt and tool catalog from that
context, so the review shares the foreground turn's prompt-cache prefix.
Omit it only for runs that have no foreground prompt, such as CLI hook
contexts; the review is skipped for those.
