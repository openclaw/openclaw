---
summary: "Blocking user-input surfaces, host tool capabilities, exec review outcomes, and paired-device command authority"
read_when:
  - You are exposing a runtime-level user-input request or `ask_user`
  - You are binding a tool surface through `params.hostCapabilities`
  - You are handling exec reviewer decisions or paired-device commands
title: "Agent harness user input and execution authority"
sidebarTitle: "User input and execution"
---

How a harness asks a person a question, binds its tool surface to host capabilities, handles the configured exec reviewer's three outcomes, and narrows paired-device command authority. Part of the [Agent harness plugins](/plugins/sdk-agent-harness) reference.

## User input and tool surfaces

Native harnesses that expose a runtime-level user-input request should use the
user-input helpers from `openclaw/plugin-sdk/agent-harness-runtime` to format
the prompt, deliver it through OpenClaw's blocking reply path, and normalize
choice/free-form answers back into the runtime's native response shape. The
helper keeps channel/TUI presentation consistent while each harness keeps its
own protocol parsing and pending-request lifecycle.

OpenClaw's own blocking question tools — `ask_user`, and a `secrets` request —
are a separate case. They register a Gateway question and then wait, and the
prompt that lets a person answer it is published by whatever runs the tool. A
harness whose tools go through the embedded tool lifecycle gets that publication
from its tool-start handler. A harness that dispatches tools itself passes
`questionPrompt` to `createOpenClawCodingTools` instead, on every path where it
builds a tool surface — a side thread is its own such path: `send` is the run's
`onToolResult`, and `messageChannel` is the conversation the prompt would appear
in. Leave it out and the question is registered but never shown, so the turn
waits out its whole timeout and then reports that nobody answered.

For schema-backed forms and literal URL confirmation, use the
`agentHarnessStructuredInput` runtime surface from the same subpath. It
snapshots bounded own data without invoking accessors, compiles supported
primitive fields into Gateway questions, and executes them with batching,
secret-input, timeout, and cancellation fencing. Harnesses keep ownership of
their protocol envelope and must pass the exact turn signal and active-owner
check; `run(...)` returns an answered, declined, cancelled, or unsupported
outcome for the adapter to translate.

Pass the original prepared attempt, including its exact `hostCapabilities`
object, as `delivery` when using the native question helpers. Core captures the
question creator's prepared caller policy and lifetime before any steering handle
is published. Copies of the capability object do not carry that binding. Built-in
tools capture their creation scope; CLI native questions retain the original
caller policy before tool-cap translation. The answering turn's model choice or
queued operation never replaces the question creator's authority.

Plain-text channel answers use this creator binding even when the runtime cannot
accept ordinary steering. Missing, closed, or mismatched creator authority produces
a visible refusal, not a new agent turn. The incoming source and creator must
both remain current through the final answer dispatch. Gateway-launched CLI MCP
tools use the same original caller snapshot, bound to their exact live grant.
Standalone attach grants have no prepared run snapshot; their questions retain
structured question controls but do not accept ordinary channel text.

Omit `gatewayCall` in `runAgentHarnessGatewayQuestion(...)` or
`agentHarnessStructuredInput.run(...)` to use the core-owned Gateway transport.
It carries each input's source and backing-run assertion through registration,
persistence, connection preparation, and hello, then checks synchronously
immediately before the resolve request is sent. A refused input releases only
its own reservation: the question remains pending and its prompt and later
valid input remain usable. Persistence and a local reservation are not an
answered transition. Closure after dispatch does not make an accepted answer
replayable. Plain-text submissions carry a fresh, bounded `resolutionId` on
`question.resolve`; the question owner records it only when that submission commits.
Host waiters request `includeResolutionId: true` on `question.waitAnswer` and use
that receipt to recover a lost response using the question waiter's existing
deadline, not a separate shorter timer. Another actor's answer, even identical
text, does not establish consumption of this input. A definitive resolve rejection
releases the input immediately; a cancelled or expired waiter proves non-consumption.

If the receipt is missing, rejected, or still pending when the waiter settles,
the host records the input as unconfirmed and non-replayable rather than sending
it through ordinary steering again. This is routing ownership, not proof that the
answer committed. Channel replies, Gateway chat, Talk, and the TUI surface the
uncertainty without starting another turn or cancelling independently accepted
backing work. Notice delivery or source adoption failure does not release the
input for replay. Backing-run abort, timeout, and error cleanup retain independent
authority.

Custom transports must preserve these request and response fields for lost-response
recovery. A legacy receipt-less response remains unconfirmed; it does not prove
that another submission answered the question. `resolutionId` is an opaque
1–128-character correlation value, not permission
to resolve a question or reuse closed-source authority. Ordinary waiters omit
`includeResolutionId` (default `false`) and receive the existing response shape;
question records, lookup results, and broadcast events never gain the receipt.
The receipt is transient question-lifecycle state, not a durable record or migration.

The shipped `AgentHarnessQuestionGatewayCall` function type is unchanged.
Legacy function overrides remain valid for ordinary, unscoped input, including
run-lifetime checks. Source-bound input with only a legacy callback fails before
input persistence or resolution I/O. Function arity or the presence of a callback
does not establish guarded transport support.

A custom guarded transport instead supplies an explicit object:

```typescript
type QuestionDispatcher = Exclude<
  Parameters<typeof agentHarnessStructuredInput.run>[0]["gatewayCall"],
  AgentHarnessQuestionGatewayCall | undefined
>;
```

That object has `version: 2` and `call(request)`. The request contains `method`,
`options` (`timeoutMs?`), `params?`, `signal?`, and a required `authority`:
`{ kind: "unscoped" }` or `{ kind: "source-bound", assertCurrent }`.
The source-bound variant requires a synchronous assertion. Invoke it after all
awaited preparation and immediately before every dispatch or retry, without an
intervening await. Never substitute an observer or an after-response check.
When delegating to `callGatewayTool`, forward the protected assertion in its
existing extra bag as
`dispatchAuthority: { version: 2, kind: "source-bound", assertCurrent }`.
The same bag accepts `kind: "run"` for run-only assertions. These are local code
contracts, not Gateway wire fields, operator settings, or new SDK exports.

Each prepared attempt also receives a versioned `params.hostCapabilities`
object. Use `bindToolSurface(...)` before exposing plugin-built OpenClaw tools,
and use its policy and approval operations for native actions. A native action
whose working directory differs from the attempt may pass
`nativeOperation: { cwd }` to `runBeforeToolCall(...)`; the host normalizes that
bounded action fact while keeping identity and policy authority closure-bound. The closure
binds the host-resolved run, sandbox, requester, route, and approval identity;
plugins must not reconstruct those fields or retain the capability after the
attempt returns. Calls made after attempt settlement fail closed.

For native-history recovery, optional `prepareContextMedia({ message, maxChars })`
reconstructs saved user attachments under that same host authority and current
media policy. Include its returned text and images in the native context budget;
do not append them as an unbounded suffix. See the
[runtime media contract](/plugins/sdk-runtime) for limits and older-host behavior.

When trajectory capture has a valid host-owned session target,
`params.hostCapabilities.trajectory` provides closure-bound `recordEvent(...)`
and `flush()` operations. The host adds session attribution, bounds and redacts
event data, and persists it through the canonical trajectory store. Treat the
capability as optional, send only structured non-secret facts, and await
`flush()` before the attempt settles; do not infer storage paths or create a
plugin-side fallback when the capability is absent.

New harnesses should implement `AgentHarnessV2` and type prepared attempts as
`AgentHarnessAttemptParamsV2`, `EmbeddedRunAttemptParamsV2`, and
`AgentHarnessSideQuestionParamsV2`; those contracts require
`hostCapabilities`. Packages adopting V2 must declare
`openclaw.compat.pluginApi: ">=2026.8.1"` (or a newer floor) so older hosts
reject them before load. Import the parameter types from the runtime subpath:

```typescript
import type {
  AgentHarnessAttemptParamsV2,
  AgentHarnessSideQuestionParamsV2,
  EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
```

The older `AgentHarness`,
`AgentHarnessAttemptParams`, and `EmbeddedRunAttemptParams` names remain
source-compatible for existing plugins, so the capability field is optional
in those deprecated parameter types through 2026-10-12. The public
`AgentHarnessSideQuestionParams` contract has the same compatibility window
and optional field. Core still supplies
the capability on every selected attempt. Compatibility is type-level only:
current harness code must not add a runtime path that operates without the
host capability.

Native harnesses that need PI-like compact tool routing should use
`createAgentHarnessToolSurfaceRuntime(...)` from
`openclaw/plugin-sdk/agent-harness-tool-runtime`. It owns
tool-search/code-mode control selection, local-model lean defaults,
runtime-compatible schema filtering, hidden catalog execution, directory
hydration, and catalog cleanup. Harnesses still own their SDK-specific tool
conversion and native execution callback.

After the last policy filter, schema quarantine, and native registration
intersection, call `finalizeAgentToolAvailability(tools, options?)` from
`openclaw/plugin-sdk/agent-harness-runtime` before snapshotting tool definitions.
It returns a new array containing the same tool objects and updates only
host-owned dependent affordances, such as collector spawning when its native
result reader is callable. It does not add tools, change profiles, replace
executors, or rebind authorization and approval wrappers.

Pass `options.toolExecutionAllow` when a run retains schemas for tools it cannot
execute. Omission uses the supplied tool set; an empty list permits no execution.
The optional synchronous `options.onPrepared(tool)` observer identifies definitions
whose owner participated, so a harness can refresh their cached schemas and
prompt text without changing unrelated definitions. Reapply finalization after
later filtering, and keep the existing attempt-lifecycle guards on every tool.
Finalization does not update declarations already registered in a native runtime.
Preserve native-owned catalog bytes and fingerprints; current executor guards
still reject unavailable modes. New host-owned declarations use the harness's
existing catalog-registration lifecycle.
OpenClaw Code Mode's joined `agents.run()` path retains internal waiting; this
helper does not make raw collector calls available without a native result reader.

## Exec reviewer outcomes

`reviewExecRequestWithConfiguredModel(...)` from
`openclaw/plugin-sdk/agent-harness-exec-review-runtime` returns an
`ExecAutoReviewDecision`, also exported by
`openclaw/plugin-sdk/agent-harness-runtime`. Plugin consumers must handle all
three outcomes explicitly:

- `allow-once` with `risk: "low"` or `risk: "medium"`: run the reviewed command
  once, subject to the current execution policy and authority checks.
- `deny`: do not run the command. Return the rationale and rejection guidance
  to the agent; never escalate this result to human approval.
- `ask`: route the request to human approval.

The rejection guidance tells the agent not to pursue the same outcome through
workarounds, indirect execution, or policy circumvention. It may choose a
materially safer alternative, or explain the risk and ask the user to approve
the exact command separately. This does not turn a plugin's `deny` result into
an automatic approval request.

The configured exec reviewer returns `ask` when no reviewer is configured, on
provider failures or timeouts, for invalid responses, or for an `allow` response
whose risk is not low or medium. Detected reviewer-directed prompt injection
returns `deny` with high risk. Facade loading or reviewer construction errors
may still reject the promise; an error is never permission to execute.

## Paired-device execution

Declare `cloudPlacement.devicePlacement.requiredNodeCommands` for the exact node
commands the harness needs to execute on a paired device. Core snapshots this
set when it creates the selected harness's host capabilities. An admitted
**Full access** session can authorize only those commands through the node
policy's `invokeNodeWithSessionFull` callback; other commands owned by the same
plugin do not inherit that permission. An absent declaration or an unlisted
command returns `undefined`, so the policy must use its ordinary approval or
denial path. Mutating the declaration during the attempt cannot widen authority.

This declaration narrows authority; it does not grant it. Pairing, command
allowlisting, hosting consent, node-local policy, and the exact live session,
placement, and turn remain independently enforced. Plugins remain trusted code,
not sandboxed by this callback.
