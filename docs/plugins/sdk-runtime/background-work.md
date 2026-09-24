---
summary: "Hook agent turns, subagent runs, and Task Flow record binding"
read_when:
  - You are dispatching an agent turn for untrusted external content
  - You are launching or waiting on a background subagent run
  - You are binding Task Flow or Task Run state to an owner session
title: "Plugin runtime background work"
sidebarTitle: "Background work"
---

Start agent work in the background: hook-dispatched turns for external content, subagent runs, and the Task Flow records that track them. Part of the [Plugin runtime helpers](/plugins/sdk-runtime) reference.

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
  <Accordion title="api.runtime.tasks">
    Prefer `api.runtime.tasks.async` for reads, managed-flow state changes, and child-task linkage. It has `runs`, `flows`, and
    `managedFlows` namespaces with the same synchronous `bindSession(...)` and
    `fromToolContext(...)` factories. Await `get`, `list`, `findLatest`, and
    `resolve`; both flow namespaces also provide awaited `getTaskSummary`.

    ```typescript
    const flows = api.runtime.tasks.async.managedFlows.fromToolContext(ctx);
    const current = await flows.get(flowId);
    ```

    The async `managedFlows` binding also provides `createManaged`,
    `tryCreateManaged`, `setWaiting`, `resume`, `finish`, `fail`, and
    `requestCancel`, plus `runTask` for linking existing work. Await creation before starting work and await each mutation
    before reporting its result. Updates check the owner, managed mode, and
    expected revision together inside the worker's SQLite transaction.

    On an ordinary persistence rejection, `createManaged` throws
    `TaskFlow persistence failed.` with the original error in `cause`;
    `tryCreateManaged` returns `null`. Both methods propagate preparation and
    input-validation errors.

    Results preserve the corresponding synchronous payloads and owner scope.
    Reads query persisted SQLite records in the shared database worker, without
    overwriting the process registry. Cold restoration also reads through the
    worker and installs a complete snapshot before exposing the registry. Concurrent
    callers share restoration, and newer synchronous writes take precedence over
    delayed snapshots. Access checks for bare owner keys await any required
    runtime configuration, plugin metadata, and consent preparation.
    Committed writes reconcile the relevant process task and flow registries before
    publication; a failed reconciliation leaves that projection dirty without
    changing the durable write result. A result describes its operation snapshot
    and may be superseded by a later mutation.

    The shared worker uses the canonical database opener and preserves classified
    schema and ownership errors. Closing the shared database waits for in-flight
    worker results and native cleanup before releasing its connection ownership.

    Lists sort newest first. Equal task timestamps sort by task ID descending;
    equal flow timestamps sort by flow ID ascending. Run-ID lookup retains its
    runtime preference and oldest-first selection, then uses task ID ascending
    for ties. When an ACP run ID is reused, lookup excludes superseded backing
    generations before applying that ordering. Backing details stay internal and
    are not included in task views. Legacy synchronous methods
    keep their existing insertion-order tie behavior.

    The synchronous read methods and corresponding managed-flow state mutations
    remain supported but are deprecated in
    favor of this opt-in surface. Their removal requires a supported external
    plugin migration and an explicitly approved Plugin SDK major release.
    Native cancellation continues through the existing namespaces. An awaited read
    does not authorize a later write: retain revision checks. Async `runTask`
    rereads the canonical flow and backing inside its write admission and refuses
    a new active link when that backing has already completed. Existing terminal
    projections can still receive metadata updates without restarting work.
    For duplicate reuse, async `runTask` uses persisted creation-time/task-ID
    order, then the existing ACP preference. Deprecated sync `runTask` preserves
    its insertion-order tie behavior.
    A worker error with code `outcome-unknown` can follow a committed write.
    The code may appear directly, in a cause, or in `AggregateError.errors` when
    cleanup also fails. Creation and child linkage propagate these errors; reread
    current state before deciding whether to retry that operation.

    Bind Task Flow and Task Run state to a trusted, existing OpenClaw owner session.

    - `managedFlows` creates and mutates managed flow records. Bind with `fromToolContext(ctx)` or `bindSession({ sessionKey, requesterOrigin })` using host-resolved context, never raw user input.
    - `flows` and `runs` provide owner-scoped DTO lookups (`get`, `list`, `findLatest`, `resolve`). `flows` also exposes `getTaskSummary`; `runs.cancel` cancels an existing task.
    - `managedFlows.get(flowId)` returns the record with its revision. The read-only `flows` DTO is not the revision-bearing mutation record.

    A skill file does not provide `api` or register a plugin. For operator/agent
    workflows, use [managed Lobster execution](/automation/taskflow#run-a-managed-lobster-workflow).
    The following contract is for actual plugin/controller code.

    **Launching and linking a child**

    `runTask` records a link to existing work; it never launches ACP/subagent
    execution. The backing task must already exist with the same owner,
    canonical run/session identities and task runtime. Arbitrary IDs or a
    `status: "running"` declaration cannot establish that authority.

    1. Create a managed flow bound to the real requester session. Handle creation failure before launching work. Binding state access does not grant subagent requester authority.
    2. Inside an active requester-bound `before_dispatch` hook for an authenticated inbound request, call `api.runtime.subagent.run` with a unique agent-qualified child session key, the task message and `completionDelivery: "current-requester"`. The Gateway captures the requester and delivery route; retain the returned canonical `runId` and `sessionKey`. Missing identities or a rejected launch are failures, not permission to fabricate a task. Ordinary runs without `current-requester` have `not_applicable` completion delivery and lack the mirrored backing needed for this link.
    3. Resolve the canonical task with the owner-bound `await runs.resolve(runId)`. Verify its owner, run id, child session key and task runtime. Use its actual `sourceId`, queued/running status and available timing facts in `await managedFlows.runTask(...)`, alongside the managed flow id and task description. Do not confuse the launch result's harness/provider metadata with the task DTO's `runtime`. The async link checks current backing again before writing; check `created` before proceeding. Controllers retaining the deprecated sync API must keep their final backing read/check and link synchronous, with no intervening `await`.
    4. Observe completion through `subagent.waitForRun` and the canonical task. A bounded wait returning `pending` or an observation timeout is not a terminal child failure and does not cancel the run. Interpret results only after actual completion. On failure, record a failed/blocked flow outcome and report it; never insert a replacement child declaration to hide launch/link refusal.
    5. Reload the managed record after awaited work. Stop for terminal state or cancellation intent; use the latest revision for the next state transition. Check every `applied` result, including `finish`/`fail`, and check `cancelled` for cancellation. On revision conflict, reread and reconcile rather than blindly retrying side effects.

    <Warning>
    A child can finish before step 3. `runTask` does not replay terminal events
    that preceded linkage, so never label a completed backing task as queued or
    running. Handle its completed result directly in the controller instead of
    creating a stale active projection. The launch/link sequence is not atomic.
    </Warning>

    `completionDelivery: "current-requester"` is available only within the
    genuine hook invocation. Do not retain that authority after the hook ends
    or call private requester-context/registry helpers. See `api.runtime.subagent`
    above for the public launch and wait contract. ACP linkage likewise requires
    an existing owner-backed ACP launch, not a standalone `runTask` declaration.

    **State without a child**

    For inline work, await `createManaged` on the async managed-flow binding,
    then await and check `setWaiting`, `resume`, `finish` or `fail` transitions
    as appropriate; no `runTask` is needed.
    Keep `stateJson` and `waitJson` bounded. Waiting metadata records the reason
    and correlation, but the controller must register the real event listener.

    Records persist in SQLite; arbitrary JavaScript is not replayed after
    restart. Reload with the same trusted owner binding and explicitly resume
    from current state. Task Flow is not a scheduler: use Automations or
    `api.session.workflow.scheduleSessionTurn(...)` for future wakeups. See
    [Task Flow](/automation/taskflow) for durability and cancellation.

  </Accordion>
</AccordionGroup>

## Harness task execution ownership

`createAgentHarnessTaskRuntime(...)` from
`openclaw/plugin-sdk/agent-harness-task-runtime` accepts an optional
`executionPid` for the local process that executes the harness's tasks. The SDK
captures its host and process start identity once when creating the scoped
runtime. Task records keep that identity so a successor Gateway can settle
running tasks whose recorded process is verifiably gone, without waiting for
their normal reconciliation grace period.

Pass only a local PID reported by the harness transport. Codex's stdio transport
provides one; its WebSocket and Unix-socket transports do not. Omit `executionPid`
for remote or unidentified owners, including Copilot, whose SDK does not expose
its process identity. The SDK never substitutes the Gateway PID. Records without
an identity retain the existing grace period, including records written before
execution ownership was available.

Bundled harnesses delivering a completion can pass
`isSourceSessionAdmissionAllowed` to `deliverAgentHarnessTaskCompletion(...)`.
Keep this callback bound to the current parent and task ownership. The delivery
owner rechecks it after asynchronous routing and immediately before a new Gateway
turn or message injection is accepted. Work already accepted keeps its own
lifecycle and can finish after the source retires. Use `signal` when the caller
also intends to cancel accepted work.

For detached native work, call `captureAgentHarnessCompletionCustody(scope)`
during the admitting parent registration. Each accepted child assignment retains
its own hold with `retain()` and passes it as `completionCustody` when delivering
its result. Release each hold when its registration or assignment ends. The hold
preserves the original operator ceiling and requester lifecycle; it does not
grant general tool access or survive revocation or Gateway closure.

Capture `captureAgentHarnessTaskAssignment(task)` from the exact task record returned
by creation or selected for recovery, before history reads. Pass the same immutable
receipt as `expectedTask` to task mutations, the event sink, and completion delivery.
Metadata changes keep that receipt valid; replacing the assignment invalidates it.
If a successful exact transition normalizes the creation timestamp, advance the
receipt only from that transition's returned record. Carry the successor through
later mutations, events, and delivery; never adopt it from a fresh task lookup.

Before admitting exact-assignment work, call the scoped task runtime's
`assertTaskAssignmentSupported()` on each registration, including reused runtimes.
This checks the original runtime owner without rebinding it to a replacement.
Local agent commands use their scoped plugin registry without requiring Gateway
activation. Retiring or replacing that owner still invalidates retained runtimes.
Custom detached runtimes must implement the optional `transitionTaskAssignment`
operation for these guarded mutations. Check its `expectedTask` against the current
record and call `assertCurrent()` immediately before persistence. An adapter without
this operation receives an explicit unsupported-operation error before effects;
legacy calls without `expectedTask` keep their existing behavior. Core never bypasses
the registered adapter to perform the write.
Native monitors reject registration before submitting a turn when the adapter
lacks this operation. Upgrade the custom adapter to support exact transitions;
existing persisted tasks remain available for recovery. Rejected registrations
release their completion custody without starting child work or scheduling retries.

Bind `createAgentHarnessTaskEventSink(...)` with that receipt as soon as the task row
exists. It routes activity only to that exact task and keeps accepted persistence
work within the admitting Gateway root during a drain. Call `settleExecution()`
after terminal persistence and the current completion handoff finish, before
sleeping delivery retries. Keep the hold until delivery settles. After restart,
recovery must obtain fresh custody from a live registration and validate its
historical task and requester; stored history never grants authority.
