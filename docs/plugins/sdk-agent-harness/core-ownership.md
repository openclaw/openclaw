---
summary: "What OpenClaw core prepares and owns before a harness runs an attempt, and the contracts a harness can declare to take some of it back"
read_when:
  - You need to know which attempt inputs core prepares for a harness
  - You are declaring native tool-policy, auth bootstrap, or session ownership
  - You are reading the prepared request-transport facts in `supports(ctx)`
title: "Agent harness core ownership"
sidebarTitle: "Core ownership"
---

What OpenClaw prepares before it calls `runAttempt`, and the narrow contracts a harness declares to own tool policy, auth bootstrap, a bound native session, or its own request transport. Part of the [Agent harness plugins](/plugins/sdk-agent-harness) reference.

## What core still owns

For ordinary concrete-model turns, OpenClaw prepares these inputs before
calling `runAttempt`:

- provider and model, including discovery and concrete request parameters
- runtime auth state, unless the harness declares that it owns auth bootstrap
- thinking level and context budget
- the OpenClaw transcript/session file
- workspace, sandbox, and tool policy
- channel reply callbacks and streaming callbacks
- model fallback and live model switching policy

A harness runs a prepared attempt; it does not pick providers, replace channel
delivery, or silently switch models. Locking a concrete model chat does not skip
model discovery, auth preparation, or Responses parameters. An explicit
`pluginOwnerId` owns session control; a later producing `agentHarnessId` is an
observation, not a native ownership claim. Bound native sessions use the separate
ownership contract below.

### Native tool-policy enforcement

Set `conversationToolPolicySupport: "exact"` only when `runAttempt` enforces every
explicit OpenClaw tool-policy layer across native and built-in tools, OpenClaw
tools, requester and configured MCP servers, apps, delegation, and resumed
threads. Core passes `params.pluginHarnessToolPolicyRestricted` as the prepared
decision that the native surface must be isolated. Default tool-profile narrowing
does not set this flag.

Harnesses with an independently managed native surface can also declare
`conversationToolPolicySafeDenyTools` using canonical OpenClaw tool names. Core
preserves the native surface only when every expanded deny is a known core tool
in that audited safe list and passes the matching names in
`params.pluginHarnessToolPolicySafeDeniedTools`. The harness must disable any
native equivalents for those names. Finite allowlists, undeclared or unknown
tool names, wildcards, and groups containing any undeclared name remain
native-surface restrictions. Omit the list to retain the conservative behavior
where every explicit restriction isolates the native surface. Because omissions
fail closed, new tools cannot silently relax the policy boundary.

Omit the declaration when any native capability can bypass those layers.
OpenClaw then visibly rejects explicitly restricted turns before invoking the
harness. The operator can switch the session to the embedded runtime or upgrade
the harness. Channel `/btw` side questions with a restrictive direct policy are
rejected by core and are not covered by this declaration.

### Harness-owned auth bootstrap

By default, core resolves provider credentials before calling a harness. A
trusted harness that can authenticate through its own native runtime may set
`authBootstrap: "harness"` on its static `AgentHarness` registration. Core can
then delegate credential bootstrap instead of rejecting a route merely because
generic provider credentials are absent. Prepared route and explicit profile
requirements still apply.

Core still forwards a compatible, explicitly selected or ordered OpenClaw auth
profile and its scoped store when one exists. The harness must resolve that
profile or its native credentials before issuing model requests, keep secrets
scoped to the attempt, and surface actionable authentication failures. Do not
set this capability on a harness that only sometimes owns authentication.
This static bootstrap capability is distinct from ownership of an already-bound
native session's model and connection.

### Bound native session ownership

The optional `resolveSessionRuntimeOwnership({ config, agentId, sessionId,
sessionKey, storePath, readPreviousSessionId, assertCurrent })` callback reports
private binding ownership. Core calls it only on the exact pinned harness after
validating the durable session identity. `sessionId` and `assertCurrent` are
required; the remaining parameters are optional. Return synchronously:

- `{ model: "native", auth: "native" }` when the binding owns both model selection
  and authentication through its native connection.
- `{ model: "native", auth: "host" }` when it owns model selection but still needs
  host auth preparation.
- `undefined` when no matching native-model binding exists. For a validated
  native harness pin, an implemented callback returning `undefined` is an
  unavailable-owner error: fail visibly, without ordinary discovery or a fresh
  native thread. Reattach the original native session before retrying.

Omitting the callback preserves normal concrete model/auth preparation for
third-party harnesses. Concrete plugin-owned chats never query it; a runtime
request or model lock alone cannot establish native ownership. Paired-node
Codex sessions use their owning node handler; a missing local binding must not
turn a misrouted continuation into a local run.

Include `modelRef: { provider, model }` only when both values are known from that
same binding. Do not infer a missing value from outer configuration, credentials,
or usage. Host-auth ownership requires this tuple before credential preparation;
native-auth pending branches may omit it until their native owner selects a model.

Read the existing private binding synchronously. Call `assertCurrent()` before
and after the read. Do not discover models, reclaim a generation, start a client,
authenticate, or mutate the binding. The assertion expires when the callback
returns. This ownership fact is neither execution authority nor credential readiness.

If the current binding is absent, `readPreviousSessionId?.()` reads the latest
predecessor for this exact physical session from the caller-selected store. It
returns `undefined` when the row is missing or has been replaced. It takes no
arguments and expires when the ownership callback returns. Use it only on a
binding miss, rather than loading the general session runtime or carrying a
lineage snapshot across awaited preparation; a current binding needs no lineage
read. The predecessor identifies a binding to inspect, not permission to reclaim
or execute it.

The Codex implementation reports native model ownership from `preserveNativeModel`.
It reports native auth only for the separate private supervision connection;
preserving a model on a managed connection leaves auth with the host. A
native-auth binding uses its verified connection instead of testing irrelevant
outer model route/auth metadata or forwarding a host profile. Native connection
policy still applies. Explicit per-run provider stream parameters are rejected
rather than dropped; use a concrete model chat to apply them.

For host-auth bindings, the actual native tuple controls model, auth, and request
transport preparation. Explicit profile locks remain strict; automatic profile
rotation remains available. Authored settings on that tuple and explicit per-run
parameters must be supported by the pinned runtime, not silently dropped or
redirected through another runtime.

Core binds steering and pending-question authority to the final prepared model
route, using the reply's original caller-policy snapshot for both its fingerprint
and incoming-message projection. Native ownership or model-selection hooks do not
replace that snapshot or authorize a different caller.

Core carries optional `expectedSessionRuntimeOwnership` into the attempt, including
`modelRef` for host-auth bindings. This is a nonauthorizing comparison, not a binding,
credential, or retained capability. Revalidate during preflight, under the binding
lease, and against the ready thread after resume before inference. A changed host-auth
tuple rejects stale prepared credentials while retaining the newly observed binding.
Native-auth connections may follow their native owner's model changes. Missing or
changed ownership must never start a replacement thread.

The same synchronous read supplies session rows, events, and session-scoped chat
metadata. Native-auth metadata omits inapplicable host availability fields only for
the session's rendered model; it does not set `available: true` or modify the shared
catalog. Pending native branches may still show a configured placeholder until a
native tuple exists.

An attempt may report `runtimeModelSelection: { provider, model }` from its ready
native thread. Core accepts this diagnostic only for a prepared native-owned run.
It records the selected model separately from response/billing attribution, so a
host finalizer's model does not overwrite the native session's selection.

### Verified setup runtime artifacts

A local harness that can supply inference for first-run setup must attest the
implementation that completed the probe. When
`params.captureRuntimeArtifact` is true, return an opaque
`result.runtimeArtifact` with a stable id and content fingerprint. Register a
matching `runtimeArtifact.validate(...)` capability that rechecks that binding
without loading a different harness or scanning unrelated plugins.

Verified OpenClaw continuations also pass `params.expectedRuntimeArtifact`.
The harness must compare it with the exact native process it acquired and fail
before starting or resuming a native thread if they differ. Ordinary agent
turns omit both fields, so content hashing stays out of the normal request hot
path. Remote/WebSocket harnesses need a server attestation contract before
they can participate; a version string alone is not an artifact identity.

The prepared attempt also includes `params.runtimePlan`, an OpenClaw-owned
policy bundle for runtime decisions that must stay shared across OpenClaw and
native harnesses:

- `runtimePlan.tools.normalize(...)` and `runtimePlan.tools.logDiagnostics(...)`
  for provider-aware tool schema policy
- `runtimePlan.transcript.resolvePolicy(...)` for transcript sanitization and
  tool-call repair policy
- `runtimePlan.delivery.isSilentPayload(...)` for shared `NO_REPLY` and media
  delivery suppression
- `runtimePlan.outcome.classifyRunResult(...)` for model fallback
  classification
- `runtimePlan.observability` for resolved provider/model/harness metadata

Harnesses may use the plan for decisions that need to match OpenClaw behavior,
but treat it as host-owned attempt state: do not mutate it or use it to switch
providers/models inside a turn.

For model-visible reply policy, `buildHarnessVisibleReplyGuidance` from
`openclaw/plugin-sdk/agent-harness-runtime` accepts the prepared delivery mode,
actual message-tool availability, and resolved `requireExplicitMessageTarget`
fact. Supply these facts for each turn. Harnesses with a separate static prompt
can use the same seam's `buildUiPresentationPrompt` for stable UI guidance,
leaving delivery and target instructions in late context.

For auxiliary session control calls, `resolveSessionModelRef` from
`openclaw/plugin-sdk/model-session-runtime` resolves the current model selection.
`prepareAgentRuntimeAuth` from `openclaw/plugin-sdk/agent-harness-runtime` selects
its auth route and ordered credential attempts from the caller's loaded auth
snapshot. Preserve the selected attempt's profile, API, and fallback restrictions
when materializing credentials; this keeps control calls on the same billing
route as agent turns.

For tools that support both standalone and Gateway execution,
`hasGatewayToolRoutingContext()` from
`openclaw/plugin-sdk/agent-harness-runtime` reports whether the caller or hosting
process owns Gateway routing. Local embedded RPC contexts do not count as a
running Gateway. A caller's or ambient binding remains present after its
Gateway retires, so dispatch can reject the stale call. The helper does not
check credentials, grant authority, or guarantee that the Gateway is available.

### Request-transport contract

`supports(ctx)` receives the resolved model transport in `ctx.modelProvider`.
Two secret-free provider-owned facts describe the selected route:

- `runtimePolicy.compatibleIds` lists the runtime ids the provider declares
  compatible with that concrete route. An absent policy means the provider did
  not declare route-level compatibility; it is not permission to assume support.
- `requestTransportOverrides: "none"` means no authored provider/model request
  override must be reproduced. `"present"` means authored headers, auth
  transport, proxy, TLS, local-service, private-network behavior, or request
  parameters exist. The fact does not expose those values.

Return `{ supported: false, reason }` when the harness cannot reproduce the
prepared transport. Do not infer support by reading raw config after selection.
Add `fallbackRuntime: "openclaw"` only when the built-in runtime can reproduce
the exact prepared request without dropping authored behavior. Core then uses
that fallback for explicit and persisted selections as well as multi-route
retry sets. Leave it absent for provider, route, or authentication failures
that must remain fail-closed.

When auth preparation yields multiple retry routes, one harness must support
all of them before dispatch. Implicit selection uses OpenClaw if no plugin can
own the full set; an explicit or persisted plugin selection fails closed unless
the plugin declares the lossless OpenClaw fallback.

### Per-turn temporal context

Native harnesses that own their model prompt can use `buildTemporalContextText`
from `openclaw/plugin-sdk/agent-harness-runtime`. It renders the same current
local date and time zone as the built-in OpenClaw runtime. It uses
`agents.defaults.userTimezone` when configured and the host zone otherwise.

Call it for each turn, after the final tool surface is known. Pass
`sessionStatusAvailable: true` only when that exact surface includes
`session_status`; this keeps the exact-time hint out of prompts where the tool
is unavailable. Carry the result through the native runtime's existing
per-turn application or developer context instead of appending it to stable
thread instructions.
