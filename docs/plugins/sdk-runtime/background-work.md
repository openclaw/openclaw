---
doc-schema-version: 1
summary: "Hook agent turns and subagent runs"
read_when:
  - You are dispatching an agent turn for untrusted external content
  - You are launching or waiting on a background subagent run
title: "Plugin runtime background work"
sidebarTitle: "Background work"
---

Start agent work in the background: hook-dispatched turns for external content and subagent runs. Part of the [Plugin runtime helpers](/plugins/sdk-runtime) reference.

## Background work namespaces

<AccordionGroup>
  <Accordion title="api.runtime.hooks">
    Dispatch isolated agent turns for untrusted external-content triggers, such
    as an email watcher. Unlike `api.runtime.subagent.run(...)`, hook dispatch
    wraps external content, serializes runs for the same session, and reports
    completion through the Gateway. Plugin turns share the cron execution
    budget without requiring the HTTP hooks endpoint. When HTTP hooks are
    enabled, one slot in that shared budget remains reserved for HTTP work.

    ```typescript
    const result = await api.runtime.hooks.dispatchHookAgentTurn({
      name: "IMAP inbox",
      agentId: "mail",
      sessionKey: "hook:imap:account:123:456",
      message: "Summarize the new email and identify any requested actions.",
      externalContentSource: "email",
      deliver: true,
      thinking: "low", // optional
      timeoutSeconds: 60, // optional
      idempotencyKey: "account:123:456", // optional
    });

    if (!result.ok) {
      api.logger.warn(`Hook agent turn was rejected: ${result.reason}`);
    }
    ```

    `agentId` is required, and `sessionKey` must begin with `hook:` and contain
    no whitespace or control characters. `externalContentSource` currently
    accepts only `"email"`; external-content wrapping cannot be disabled. Set
    `deliver` to `false` to record completion without announcing it. Successful
    admission returns `{ ok: true, runId }`; rejected admission returns
    `{ ok: false, reason }`.

    This capability is available only to bundled plugins and trusted official
    plugin installations. It does not require enabling or configuring the HTTP
    hooks endpoint.

  </Accordion>
  <Accordion title="api.runtime.subagent">
    Launch and manage background subagent runs.

    For a tool-free completion that needs no retained session or reply delivery,
    use `complete(...)`:

    ```typescript
    const { text } = await api.runtime.subagent.complete({
      agentId: "research", // required configured agent that owns this work
      message: "Summarize these notes.",
      extraSystemPrompt: "Return a concise summary.", // optional
      timeoutMs: 30_000, // optional; defaults to 30 seconds
      // model: "openai/gpt-5.6-luna", // optional authorized override
      // signal: abortController.signal, // optional cancellation
    });
    ```

    `agentId` and `message` are required. `extraSystemPrompt`, `model`,
    `timeoutMs`, and `signal` are optional. The selected agent supplies its
    configured default model and credential owner when `model` is omitted.
    The result is `{ text: string }`; no session creation, message polling,
    deletion, or completion delivery is needed. The configured runtime must
    support fresh, tool-free isolated inference; unsupported runtimes fail
    before inference.

    Completions use the [shared background queue](/concepts/queue#background-work),
    with up to three runs per plugin within the three-run total budget.
    Cancellation removes queued work immediately. Running work keeps its slot
    until underlying runtime cleanup finishes, then rejects; late output is not
    returned after cancellation, timeout, or runtime retirement. Calls require
    a live Gateway binding and plugin identity. Request-scoped calls retain the
    caller's operator scopes and agent access; completions started inside an
    operator tool invocation are cancelled when that invocation ends.
    Model overrides retain the
    existing subagent authorization and `allowedModels` policy below.

    Use `run(...)` when you need a session or an agent tool surface:

    ```typescript
    // Start a subagent run
    const { runId, sessionKey } = await api.runtime.subagent.run({
      sessionKey: "agent:main:subagent:search-helper",
      message: "Expand this query into focused follow-up searches.",
      toolsAlsoAllow: ["my_plugin_progress"],
      promptMode: "minimal", // optional bounded subagent prompt
      provider: "openai", // optional override
      model: "gpt-6-astra", // optional override
      deliver: false,
      completionDelivery: "current-requester", // optional, before_dispatch hooks only
    });

    // Wait for completion
    const result = await api.runtime.subagent.waitForRun({ runId, timeoutMs: 30000 });

    // Read session messages
    const { messages } = await api.runtime.subagent.getSessionMessages({
      sessionKey: "agent:main:subagent:search-helper",
      limit: 10,
    });

    // Delete a session
    await api.runtime.subagent.deleteSession({
      sessionKey: "agent:main:subagent:search-helper",
    });
    ```

    Gateway-backed runs return the canonical accepted `sessionKey` alongside `runId`. The field is optional in the TypeScript result only so explicit custom runtimes remain compatible.

    `waitForRun(...)` returns the canonical Gateway wait result. `status` is `"ok"`, `"error"`, `"timeout"`, or `"pending"`; pending is a normal nonterminal observation, not an exception. Optional `error`, `startedAt`, `endedAt`, `stopReason`, `livenessState`, `yielded`, `pendingError`, `timeoutPhase`, `providerStarted`, and `terminalReply` metadata is preserved so callers can distinguish observation timeouts from terminal outcomes. `timeoutMs` bounds the wait call; it does not cancel the run.

    <Warning>
    Outside an authorized Gateway request, model overrides require operator opt-in via `plugins.entries.<id>.subagent.allowModelOverride: true` in config. Plugins without that opt-in can use the configured model, but override requests are rejected.
    </Warning>

    `plugins.entries.<id>.subagent.allowedModels` can restrict overrides to
    canonical `provider/model` targets. The same policy applies to `complete`;
    request-scoped calls retain their authenticated client's override authority.
    The check uses the destination agent's model configuration, including exact
    configured model IDs, and applies to the plugin's initial override. Configured
    defaults, operator-installed model routing hooks, and automatic model fallbacks
    retain their own selection policies.

    `toolsAlsoAllow` adds exact, uniquely owned tools registered by the calling plugin to the worker's normal tool surface. The runtime rejects core tools and names shared with another plugin. Profiles and operator tool policies still apply, including explicit allowlists and denies.

    Owner-authorized command launches can pass their captured assertion as
    `subagent.run({ ..., assertCurrent })`; the Gateway applies it at run
    admission. Managed `worktrees.create({ ..., commitGuard })` accepts the same
    assertion through its existing creation owner. Revocation prevents pending
    launches or worktree writes, while accepted work retains its cleanup and
    completion responsibilities.

    `promptMode: "minimal"` selects the bounded subagent prompt instead of the full conversation prompt. The plugin runtime exposes only this mode; omission keeps the full prompt. Use `disableTools: true` as well when the run must have an exact empty tool surface.

    `completionDelivery: "current-requester"` is default-off and is only available while a `before_dispatch` hook is handling an authenticated inbound request. OpenClaw captures the canonical requester session and delivery route before invoking the plugin, then delivers the subagent completion through the normal announce path. Plugins cannot provide or override requester lineage or destination fields. Calls outside that requester-bound hook context are rejected.

    `deleteSession(...)` can delete sessions created by the same plugin through `api.runtime.subagent.run(...)`. Deleting arbitrary user or operator sessions still requires an admin-scoped Gateway request.

  </Accordion>
</AccordionGroup>

## Native harness completion delivery

Bundled harnesses use `openclaw/plugin-sdk/agent-harness-completion` to route
native child results through the existing requester completion-delivery owner.
`deliverAgentHarnessCompletion` requires a host-issued `AgentHarnessCompletionScope`
and a live `isSourceSessionAdmissionAllowed` callback. Keep the callback bound
to the exact native assignment and its current parent. Requester identity and
admission are rechecked after awaited routing and before new effects.
Native runtime history, cancellation, and submission receipts remain owned by
the harness; there is no generic task registry or managed-flow API.

For detached native work, await `captureAgentHarnessCompletionCustody(scope)`
during the admitting parent registration, before publishing the registration or
starting native child work. Preparation retains the original requester lifecycle
and rejects replacement or revocation before returning custody. Each accepted child assignment retains
its own hold with `retain()` and passes it as `completionCustody` when delivering
its result. Release each hold when its registration or assignment ends. The hold
preserves the original operator ceiling and requester lifecycle; it does not
grant general tool access or survive revocation or Gateway closure.

Bind `createAgentHarnessCompletionEventSink(...)` to the same completion custody
and an `isSourceCurrent` callback for the exact native assignment. After native
terminal persistence and the first completion handoff settle, call
`completionCustody.settleExecution()` before sleeping delivery retries. This
releases the execution drain obligation while retaining completion delivery
authority. After a restart, recovery must capture fresh custody from a live
registration and validate its requester; stored history never grants authority.
