---
summary: "api.runtime -- the injected runtime helpers available to plugins"
title: "Plugin runtime helpers"
sidebarTitle: "Runtime helpers"
read_when:
  - You need to call core helpers from a plugin (TTS, STT, image gen, web search, Gateway, subagent, nodes)
  - You want to understand what api.runtime exposes
  - You are accessing config, agent, or media helpers from plugin code
  - You are implementing model-picker persistence in a channel plugin
---

Reference for the live `api.runtime` object available during `"full"`, `"discovery"`, `"tool-discovery"`, and `"setup-runtime"` registration. During `"cli-metadata"` and `"setup-only"` registration, runtime capabilities are intentionally unavailable: accessing one throws an error naming the plugin and mode. Defer runtime access out of `register()` or, for root CLI commands, declare `cliCommands` in the plugin manifest. Use runtime helpers instead of importing host internals directly.

<CardGroup cols={2}>
  <Card title="Channel plugins" href="/plugins/sdk-channel-plugins">
    Step-by-step guide that uses these helpers in context for channel plugins.
  </Card>
  <Card title="Provider plugins" href="/plugins/sdk-provider-plugins">
    Step-by-step guide that uses these helpers in context for provider plugins.
  </Card>
</CardGroup>

```typescript
register(api) {
  const runtime = api.runtime;
}
```

`api.runtime.version` is the current OpenClaw product version, sourced from the shared version resolver so plugins see the same value the CLI reports.

`api.runtime.capabilities` is an optional, read-only list of host behavior
guarantees. Older hosts may omit it. Check a documented capability ID before
enabling behavior that depends on it; equal product versions and tool names do
not establish support. These process-stable facts do not grant caller authority,
and they remain unavailable during metadata-only registration.

`sender-restricted-hidden-helpers-v1` guarantees that sender-restricted requesters
can start only hidden helpers of the same agent, retaining their restricted tool
surface and session root. Channels may use this capability to enable helper
tools for restricted senders. Core remains responsible for authorization and
containment. The same ID is advertised in Gateway `hello-ok.features.capabilities`.

## What each page covers

- [Config and utilities](/plugins/sdk-runtime/config-and-utilities) — runtime config reads and writes, plus the shared process, error, and model-picker utilities.
- [Agent and sessions](/plugins/sdk-runtime/agent) — agent identity, directories, session store, transcripts, and sandbox authority.
- [Model helpers](/plugins/sdk-runtime/models) — host-owned completions, model-selection policy, and provider auth resolution.
- [Background work](/plugins/sdk-runtime/background-work) — hook agent turns, subagent runs, and native harness completion delivery.
- [Gateway and nodes](/plugins/sdk-runtime/gateway-and-nodes) — in-process Gateway requests, bounded session facts through `gateway.readSessionFacts`, paired node invocation, and Gateway service events.
- [Media helpers](/plugins/sdk-runtime/media) — speech, media understanding, image/video/music generation, web search, and media utilities.
- [State and system](/plugins/sdk-runtime/state-and-system) — config snapshot, SQLite-backed plugin state, system utilities, events, and logging.
- [Channel helpers](/plugins/sdk-runtime/channel) — channel-specific runtime helper groups for chunking, routing, pairing, media, and mentions.

## Runtime namespaces

Every `api.runtime` namespace and the page that documents it.

| Namespace                        | Page                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `api.runtime.agent`              | [Agent and sessions](/plugins/sdk-runtime/agent#api-runtime-agent)              |
| `api.runtime.agent.defaults`     | [Agent and sessions](/plugins/sdk-runtime/agent#api-runtime-agent-defaults)     |
| `api.runtime.llm`                | [Model helpers](/plugins/sdk-runtime/models#api-runtime-llm)                    |
| `api.runtime.gateway`            | [Gateway and nodes](/plugins/sdk-runtime/gateway-and-nodes#api-runtime-gateway) |
| `api.runtime.hooks`              | [Background work](/plugins/sdk-runtime/background-work#api-runtime-hooks)       |
| `api.runtime.subagent`           | [Background work](/plugins/sdk-runtime/background-work#api-runtime-subagent)    |
| `api.runtime.sandbox`            | [Agent and sessions](/plugins/sdk-runtime/agent#api-runtime-sandbox)            |
| `api.runtime.nodes`              | [Gateway and nodes](/plugins/sdk-runtime/gateway-and-nodes#api-runtime-nodes)   |
| `api.runtime.tts`                | [Media helpers](/plugins/sdk-runtime/media#api-runtime-tts)                     |
| `api.runtime.mediaUnderstanding` | [Media helpers](/plugins/sdk-runtime/media#api-runtime-mediaunderstanding)      |
| `api.runtime.imageGeneration`    | [Media helpers](/plugins/sdk-runtime/media#api-runtime-imagegeneration)         |
| `api.runtime.videoGeneration`    | [Media helpers](/plugins/sdk-runtime/media#api-runtime-videogeneration)         |
| `api.runtime.musicGeneration`    | [Media helpers](/plugins/sdk-runtime/media#api-runtime-musicgeneration)         |
| `api.runtime.webSearch`          | [Media helpers](/plugins/sdk-runtime/media#api-runtime-websearch)               |
| `api.runtime.media`              | [Media helpers](/plugins/sdk-runtime/media#api-runtime-media)                   |
| `api.runtime.config`             | [State and system](/plugins/sdk-runtime/state-and-system#api-runtime-config)    |
| `api.runtime.system`             | [State and system](/plugins/sdk-runtime/state-and-system#api-runtime-system)    |
| `api.runtime.events`             | [State and system](/plugins/sdk-runtime/state-and-system#api-runtime-events)    |
| `api.runtime.logging`            | [State and system](/plugins/sdk-runtime/state-and-system#api-runtime-logging)   |
| `api.runtime.modelConfig`        | [Model helpers](/plugins/sdk-runtime/models#api-runtime-modelconfig)            |
| `api.runtime.modelAuth`          | [Model helpers](/plugins/sdk-runtime/models#api-runtime-modelauth)              |
| `api.runtime.state`              | [State and system](/plugins/sdk-runtime/state-and-system#api-runtime-state)     |
| `api.runtime.channel`            | [Channel helpers](/plugins/sdk-runtime/channel#api-runtime-channel)             |

## Storing runtime references

Synchronous storage compatibility calls retain their synchronous return contract.
Managed commits install their available facts before public change notifications;
a notification failure does not roll back the stored change. The private
[receipt/completeness contract](/reference/database-schemas/worker-access#committed-facts-and-completeness)
adds no public capability or deprecation. Plugins must still use the owning
runtime operation and its live authority checks: a prior receipt or cached row
does not certify raw-handle writers, foreign changes, or a later effect.

The Gateway context's GitHub publication service has V2 request methods with
required host-owned requester capabilities, plus awaited deferral and reporting
methods. Forward those capabilities intact and await committed results before
releasing request resources. Released opaque-requester and synchronous lifecycle
methods remain deprecated compatibility routes; actual use shares one warning
budget per plugin and publication family. See
[GitHub publication migration](/plugins/sdk-migration/how-to-migrate#await-github-publication-operations)
for the method mapping, callback ordering, and next-major removal contract.

Use `createPluginRuntimeStore` to store the runtime reference for use outside the `register` callback:

<Steps>
  <Step title="Create the store">
    ```typescript
    import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
    import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

    const store = createPluginRuntimeStore<PluginRuntime>({
      pluginId: "my-plugin",
      errorMessage: "my-plugin runtime not initialized",
    });
    ```

  </Step>
  <Step title="Wire into the entry point">
    ```typescript
    import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

    // `myPlugin` is your own `ChannelPlugin` object and `store` is the store
    // created in the previous step; neither is an SDK export.
    export default defineChannelPluginEntry({
      id: "my-plugin",
      name: "My Plugin",
      description: "Example",
      plugin: myPlugin,
      setRuntime: store.setRuntime,
    });
    ```

  </Step>
  <Step title="Access from other files">
    ```typescript
    export function getRuntime() {
      return store.getRuntime(); // throws if not initialized
    }

    export function tryGetRuntime() {
      return store.tryGetRuntime(); // returns null if not initialized
    }
    ```

  </Step>
</Steps>

<Note>
Prefer `pluginId` for the runtime-store identity. The lower-level `key` form is for uncommon cases where one plugin intentionally needs more than one runtime slot.
</Note>

## Plugin lifecycle and cleanup

A managed plugin instance owns its registered callables, runtime-store slots,
and loaded source generation. Retiring the instance stops new calls through
its managed handles. Already admitted calls and streams have a bounded chance
to finish before disposal; retaining an old function does not make it a current
runtime handle.

### Plugin value boundary

OpenClaw admits native plugins when it loads and registers them, using the
existing [manifest validation](/plugins/manifest) and
[load policy](/plugins/architecture-internals/load-pipeline). Every loaded native
plugin uses the same value contract: hook results, tool results, and stream
events cross by reference. The plugin boundary does not copy, freeze,
deep-inspect, or attach lazy readers to these values.

Plugin authors must not mutate values after handing them to the host, including
nested objects and byte buffers. Produce a new value for a later update.
Registered callables retain their instance scope, receiver binding, and lifecycle
fencing. Plugin code runs inside a Gateway request scope established for its
invocation.

Host-created request scopes borrow their plugin registry. A direct registry-scope
callback keeps its registry until its returned operation settles; detached async
resources do not extend that lifetime. Access to a released registry fails instead
of silently selecting the current generation. Admitted turns and explicitly
retained consumers keep their selected generation until they settle.
Registry-dependent runtime APIs re-enter their live plugin owner after adoption
and preserve an explicitly prepared registry, including an empty selection.

Submitting a SessionManager append transfers its ordinary JSON payload to the
manager by reference. Treat the payload as immutable from submission, including
while an asynchronous append is pending; nested objects and arrays are frozen.
Append receipts and transcript views share that immutable payload. Create a new
value for a later update. Custom JSON representations are normalized before
persistence. Tool arguments, tool results, and transcript text are not
secret-masked; image and provider replay metadata still receive structural
normalization.

An admitted iterator owns its invocation scope and call lease for its lifetime.
Advancing or closing it executes plugin code in that scope without creating a
new scope for each event. Completion, cancellation, and stream cleanup settle
that same lease. If `return()` yields from a generator's `finally` block, a later
resumption acquires a new lease through the original owner and scope. A retained
iterator cannot acquire fresh authority after its owner closes.

Native plugins execute in the Gateway process and are not sandboxed. Provenance
diagnostics and capability-specific trust requirements, such as hook agent turns
and Gateway scope elevation, still apply. Every loaded plugin can
use its own [state and ingress queues](/plugins/sdk-runtime/state-and-system#api-runtime-state),
regardless of provenance. `plugins.allow` permits loading without verifying source provenance. These
load-time facts belong to the instance until the plugin owner replaces it through
restart or an explicit reload or installation operation.

Context engines selected by an admitted turn remain owned through that turn's
commit and engine disposal. Replacing an enabled plugin waits for those consumers
to close before registering its successor. Disabling or removing a plugin can
report their cleanup as deferred; starting engine disposal closes normal engine
callbacks while cleanup finishes.

Replacement validates metadata and configuration first, then stops services and
channels, drains admitted work, runs `gateway_stop`, and disposes the old instance
before invoking the new registration. Session-extension and runtime-lifecycle
`cleanup` callbacks receive `reason: "restart"` before the replacement registers,
so they can unsubscribe observers and release in-memory buffers. Persistent
session-state and scheduler reconciliation remain part of registry retirement.
Pre-publication failure triggers automatic
recovery by registering the captured previous code with its previous config;
a stopped instance is not assumed to be restartable. A plugin cannot synchronously
replace itself from its own active call: the operation rejects before shutdown
and can be retried after that call finishes. Cleanup that cannot finish within
its budget can prevent safe replacement or recovery. Unaffected instances remain
active, and the Gateway process stays running.

Managed instances expose `api.lifecycle.signal` and
`api.lifecycle.onDispose(cleanup)`. The signal aborts when disposal reaches
explicit cleanup. `onDispose` accepts a synchronous or asynchronous callback and
returns a function that unregisters it. Callbacks run once, in reverse registration
order, within a shared cleanup budget. A throwing or unfinished callback is
recorded as a cleanup failure while the remaining cleanup is attempted. These
fields are optional in the SDK type because an API host without a managed
instance may omit them; feature-detect them before relying on instance cleanup.
The existing `api.lifecycle.registerRuntimeLifecycle(...)` contract remains
available for plugin-owned host state.

### Instance-bound background context

Managed instances also expose the additive
`api.lifecycle.runInBackgroundContext<T>(run: () => T): T` capability. It runs
immediately and returns the callback's value or promise. It detaches the calling
turn, request, and unrelated async-local context while preserving the instance's
host resource bindings. Each call selects that exact instance's current adopted
registry, so a retained plugin sees replacement providers after a reload.

Use it when installing timers, watchers, and listeners, and again when delivering
each background callback. Keep the runner with the resource that owns it; an old
manager must not look up a replacement plugin instance. Return asynchronous work
from the callback so the instance retains it until it settles. Disposal does not
wait for this work before running `onDispose`, so cleanup can stop the work and
safely await it; module teardown still waits for it to settle, and work that
outlives the cleanup budget is force-retired like other calls. New calls reject after admission
closes; already admitted host cleanup retains its teardown authority. The runner
does not schedule work or cancel native resources: release those in the existing
cleanup owner. Like the other instance lifecycle fields, it can be absent on an
API host without a managed instance.

Inspection release reports settled disposal failures without marking the managed
resources as still retained. Prepared-model shutdown records those failures and
can finish after cleanup settles. Unfinished disposal and failed host cleanup
prerequisites still prevent shutdown from reporting a completed resource release.

Stopping or restarting the Gateway preserves persistent plugin session state and
runs host cleanup hooks with reason `restart`. Disabling or removing a plugin owns
deleting that state. After admitted cleanup settles, plugin callback failures are
reported with the plugin and hook name as shutdown warnings; they do not turn a
normal stop into a failed process exit. Failed session-state cleanup and unfinished
write-capable work still prevent a clean shutdown.

Cleanup is best effort. Plugins must explicitly release their own timers,
listeners, sockets, watchers, and child processes in `onDispose` or their
service's `stop()` method. OpenClaw does not intercept those native resources or
prove that they have stopped when managed retirement completes. Native plugins
remain trusted, in-process code. Plain data and native byte buffers retain their
normal identities; lifecycle fencing applies to the managed callable surfaces,
not every object a plugin can retain.

Release the stored handle as well as canceling a timer. On Node, a canceled
timer object can still retain the async context in which it was created:

```ts
clearInterval(timer);
timer = undefined;
```

This matters for module-level state in native ESM plugins: Node can retain an
evaluated module after replacement. Removing the captured files and closing its
managed callbacks does not unload that native module or clear its variables.
Drop references to stopped resources and other disposable state in cleanup.

Opaque values returned by a plugin can be passed back directly or in data-only
records and arrays. Caller-owned objects with methods or accessors are passed
unchanged, including any handles inside them.

`createPluginRuntimeStore` resolves its slot from the invoking managed instance.
Preparing another instance does not overwrite that instance's runtime. Calls
outside managed instance scope retain the store's existing standalone behavior.
Gateway-hosted agent turns use the admitting Gateway's own instance for each
unchanged plugin: same source, install, manifest, activation, entry policy, and
configuration, in the Gateway's workspace and environment. The lender comes from
the admitting Gateway owner, never another Gateway that happens to be process-active.
Without an unambiguous live owner, preparation loads separate instances. Borrowing
turns run the Gateway's `registrationMode: "full"` registrations and share its
services and runtime store; only plugins the Gateway lacks or configures
differently load a separate discovery instance. After `openclaw plugins reload`,
later turns use the reloaded Gateway instance, and the reload waits for turns that
still hold the previous one. Borrowed channel methods and read-authority grants
expire with the borrowing runtime or invocation scope; retiring the borrower does
not retire the Gateway's instance.

Turns that load a plugin separately borrow its tool registrations from the
admitting Gateway's current registry, so factories and execution share the
instance whose services initialized the runtime. Adoption requires the same
plugin source, configuration, non-empty set of declared tool names, and
optionality. It preserves discovery's tool membership and order. Without an
unambiguous admitting Gateway owner, turns keep their discovery registrations.

SDK helpers that return bare results retain their resources until the owning
host closes. Callers do not need to dispose those results; see
[Prepared simple completions](/plugins/sdk-runtime/models#prepared-simple-completions).

First-party bounded persistence sequences retain their original agent executor
before asynchronous preparation and release it after publication cleanup. The
private `sqlite-runtime` facade exposes that existing owner and its recorded
native identity; each worker command keeps its own FIFO turn and live authority
checks. Native maintenance and private shadow stores keep their existing owners.

SQLite worker backends set connection lock-wait policy with
`setSqliteBusyTimeout` from `openclaw/plugin-sdk/sqlite-worker-runtime`, including
temporary changes. The connection owner retains the current timeout, skips
unchanged assignments, and discards it on close; raw timeout PRAGMAs on an owned
connection would bypass that policy.

`readSqliteDatabaseWriteTokenForPath` from `openclaw/plugin-sdk/sqlite-runtime`
reads the existing physical database identity and in-process writer receipt without
issuing SQL or a worker request. Retained row caches may reuse results only when
the token is defined and unchanged before and after reading. An undefined token
means cache reuse is unproven, including while a write is unsettled; it does not
deny an ordinary read or grant effect authority. A changed token invalidates every
derived cache that depends on that database, including caches in sibling plugin
instances. The helper does not observe writes by other processes.

First-party runtime callers use `openOpenClawAgentSqliteWorkerStoreV2` from the
same subpath to admit cold agent storage without receiving a writable native
handle. Its required live authority runs inside worker grants and must not read
the same database or do blocking work. Put same-database predicates in the paired
worker transaction. Explicit `prepare()` owns creation; `executeExisting` keeps
missing storage absent. The deprecated `withOpenClawAgentDatabaseRuntime` and
`withOpenClawAgentDatabaseAsync` retain their native callbacks and admission
ordering, including the latter's post-integrity, pre-repair checkpoint, until
the next Plugin SDK major. Awaiting those callbacks does not move SQL off-thread.

Transcript assertion composition preserves prepared source checks independently
of opaque SDK callbacks. Cold restoration can recheck those prepared components
and their stored predicates while retaining the full synchronous assertion for
native commit. Custom SDK assertion wrappers are not executed in restoration
worker grants; existing writer adapter selection remains unchanged.

`await api.runtime.agent.session.createSessionEntryListReader({ agentId, storePath, env? })`
creates a read-only metadata inventory reader for a durable session store.
Await the returned function to read `{ entries, assertCurrent }`. It reuses
entries only after a worker verifies the same database connection and revision;
foreign commits and reopened databases invalidate them. Entries exclude saved
prompt snapshots and derived participants. Treat them as immutable. The returned
assertion checks physical source identity, not sharing permissions or row freshness;
revalidate access before publishing data after an await. Keep the reader within
its consumer's lifecycle and discard it when configuration changes.

`cleanupSessionLifecycleArtifacts` from `openclaw/plugin-sdk/session-store-runtime`
joins the selected database owner's pending startup preparation before capturing
its physical identity. Prepared agents do not wait. Failed preparation still
surfaces through normal database admission checks; Gateway shutdown cancels the wait.

### Memory runtime replacement

Memory runtimes may implement `prepareReload({ retireRuntime, retiringEmbeddingProviders })`
and return `drain()` and `resume()`. Preparation synchronously fences affected
manager acquisition, including lazy and fallback work. Match the exact acquired
adapter objects rather than provider IDs. Drain removes affected managers from
reuse before attempting to close them. It may return `{ errors }` to report
cleanup failures. Resume reopens admission after cancellation, or after publication
when the runtime is retained, even if old cleanup remains unfinished. Retiring
managers must not publish late results into a replacement manager's caches.

Preparing an unused runtime must leave its manager engine unloaded. For runtimes
without this hook, OpenClaw calls the existing `closeAllMemorySearchManagers`
method, when provided, if the runtime or an embedding adapter retires. This closes
all of that runtime's managers as best-effort cleanup; it cannot identify dependent
managers or prevent concurrent manager acquisition.

## Browser meeting transport builders

`MeetingPlatformAdapter.createBrowserAdapterOptions` builds the `browser` and
`parsing` options for `MeetingPlatformAdapter.create` from platform page scripts,
permission origins, display names, manual-action prefixes, and retry policy.
`MeetingPlatformAdapter.createPageScripts` assembles status, transcript, audio
capture, and leave scripts while the plugin supplies identity and control sources.
Its `statusPrelude` and `statusCall` descriptors share the factory's `platform`
metadata, including page globals and audio/manual-action prefixes.

`createStatusPreludeSource` accepts either source strings or callbacks for
`lifecycleSource` and `manualActionSource`. Callbacks receive shared fragments for
guest names, preserved identity, virtual audio input, microphone control, and
manual actions. Existing string-based callers keep their generated source.

## Browser meeting status ownership

`MeetingPlatformAdapter.createStatusCallSource` accepts an optional
`liveOwnershipSource`: a JavaScript boolean expression evaluated in the generated
status script's page scope. Use it when call ownership can change while device
enumeration, speaker routing, or playback is awaiting completion. A false result
stops that routing pass, restores matching sources through the session's audio
cleanup helpers, retires owned bridges, and reports output as unrouted and
retryable. Omitting the option leaves the generated status source unchanged.

## Browser meeting participation

The existing `openclaw/plugin-sdk/meeting-runtime` entry point exposes optional
participation methods on `MeetingSessionRuntime`. Supply its `participation`
options with an SQLite plugin keyed store, current capabilities, action
validation, and a provider executor. Providers observe canonical source identity,
epoch, revision, and finality through `observeParticipationSource`; never accept
these fields from model arguments. `inspectParticipationSource` returns a
snapshot and a live guard for work that crosses asynchronous boundaries.

The participation-specific named exports are `runMeetingParticipationWithBrowser`,
`MeetingBrowserParticipationAdapter`, `MeetingParticipationRequest`,
`MeetingParticipationSource`, and `MeetingParticipationAttempt`. Other payload
and option shapes remain part of the typed runtime and adapter signatures rather
than separate top-level SDK aliases.

Each session retains at most 1,024 live sources for two minutes from their first
observation. Capacity admission and eviction use original observation order, not
snapshot replay or correction time. Repeated snapshots preserve unchanged
retained references and guards; older replayed sources cannot displace newer
ones from a full live-source window.

Retained transcript rows carry a separate `provenance` envelope: observer, optional
observation/session/document identifiers and observation time, observed speaker
label, and native `self`, `other`, or `unknown` attribution. Speaker labels are not
participant identities. Missing or malformed attribution remains unknown; a
provenance record never grants participation authority. Interim, historical, own-echo,
and otherwise non-actionable rows retain provenance independently of `source`.

This is a retained-snapshot contract, not a revision journal. Unchanged polls keep
unchanged observation identifiers; intermediate states between polls need not be
retained. Existing transcript storage carries the envelope in
`metadata.meetingObservationProvenance` on the utterances it already stores, under
the existing retention policy. There is no separate observation archive. Removing
one DOM copy must not finalize a source that still has a live copy.

Browser adapters may implement `MeetingBrowserParticipationAdapter` and dispatch
through `runMeetingParticipationWithBrowser`. The helper uses the existing tab
lock, a pinned route, and the session guard. An optional preparation script may
open controls and await readiness, but must not perform the requested action.
After preparation the host revalidates authority. The final script checks the
page session and URL and performs its effect synchronously before its first
await; later waits may observe the result but must not produce another effect.
Only a rejected result that proves no requested effect occurred may set
`correctable: true`. Other meeting platforms need no adapter change and continue
to report unsupported participation.

Cancellation after browser dispatch is best effort: the effect may occur before
the host detects source expiry, correction, or session revocation. The runtime
reports that outcome as `uncertain`; it must not be treated as proof of cancellation
or permission to retry with a new request ID. Pre-dispatch authority checks and
the adapter's final page-session and URL checks remain required.

## Worker provider allocation authority

The Gateway supplies `assertCurrent()` in the options passed to worker providers'
`provision` and `prepareProvision` methods. This required runtime callback binds
the operation to the live environment owner and any requesting run. Invoke it
after awaited preparation and immediately before an allocation, checkpoint fork,
or adoption. A non-aborted `signal` does not prove that the caller still has
authority. Providers with project preparation must compose this callback with
`project.assertCurrent()` so both owners remain current.

The callback belongs to the provision attempt. Carry it into a returned prepared
allocation closure, but never serialize it or retain it in a durable or reusable
preparation record. After the attempt closes, the callback rejects retained work.
Teardown keeps its existing cleanup authority and must still settle an owned
lease when the requesting run has ended.

The legacy optional parameter shape remains source-compatible until the next
declared breaking Plugin SDK revision. It is not a capability-free runtime path:
current hosts supply this assertion, and bundled providers reject missing
allocation authority before performing work. An older host must be updated to
use these providers.

## Other top-level `api` fields

Beyond `api.runtime`, the API object also provides:

<ParamField path="api.id" type="string">
  Plugin id.
</ParamField>
<ParamField path="api.name" type="string">
  Plugin display name.
</ParamField>
<ParamField path="api.config" type="OpenClawConfig">
  Read-only config snapshot supplied when this instance registers. With the default hybrid
  reload mode, changes to this plugin's `plugins.entries.<id>` replace its instance
  by default and rerun registration. A retained instance keeps its snapshot across unrelated
  config changes. In long-lived callbacks, prefer the supplied `cfg`, or use
  `api.runtime.config.current()` when no config is passed.
</ParamField>
<ParamField path="api.pluginConfig" type="Record<string, unknown>">
  Plugin-specific config from `plugins.entries.<id>.config`, captured at registration.
  Ordinary edits to this config automatically replace the instance in hybrid mode,
  unless a narrower plugin reload policy applies. Source or manifest edits still
  need [plugin Reload](/cli/plugins#reload).
</ParamField>
<ParamField path="api.logger" type="PluginLogger">
  Scoped logger (`debug`, `info`, `warn`, `error`).
</ParamField>
<ParamField path="api.registrationMode" type="PluginRegistrationMode">
  Current load mode: `"full"` (live activation), `"discovery"` / `"tool-discovery"` (read-only capability discovery), `"setup-only"` (lightweight setup entry), `"setup-runtime"` (setup flow that also needs the runtime channel entry), or `"cli-metadata"` (CLI command metadata collection).
</ParamField>
<ParamField path="api.resolvePath(input)" type="(string) => string">
  Resolve a path relative to the plugin root.
</ParamField>

## Where each section moved

Every section heading and namespace anchor from the previous single-page version keeps its anchor here, so an existing link such as `/plugins/sdk-runtime#api-runtime-subagent` still resolves. Each entry points at the page that now holds the content.

- <a id="config-loading-and-writes" />[Config loading and writes](/plugins/sdk-runtime/config-and-utilities#config-loading-and-writes)
- <a id="reusable-runtime-utilities" />[Reusable runtime utilities](/plugins/sdk-runtime/config-and-utilities#reusable-runtime-utilities)
- <a id="stage-timing-diagnostics" />[Stage timing diagnostics](/plugins/sdk-runtime/config-and-utilities#stage-timing-diagnostics)
- <a id="plugin-command-runtime-helpers" />[Plugin command runtime helpers](/plugins/sdk-runtime/agent#plugin-command-runtime-helpers)
- <a id="gateway-service-events" />[Gateway service events](/plugins/sdk-runtime/gateway-and-nodes#gateway-service-events)
- <a id="api-runtime-agent" />[`api.runtime.agent`](/plugins/sdk-runtime/agent#api-runtime-agent)
- <a id="api-runtime-agent-defaults" />[`api.runtime.agent.defaults`](/plugins/sdk-runtime/agent#api-runtime-agent-defaults)
- <a id="api-runtime-llm" />[`api.runtime.llm`](/plugins/sdk-runtime/models#api-runtime-llm)
- <a id="api-runtime-gateway" />[`api.runtime.gateway`](/plugins/sdk-runtime/gateway-and-nodes#api-runtime-gateway)
- <a id="api-runtime-hooks" />[`api.runtime.hooks`](/plugins/sdk-runtime/background-work#api-runtime-hooks)
- <a id="api-runtime-subagent" />[`api.runtime.subagent`](/plugins/sdk-runtime/background-work#api-runtime-subagent)
- <a id="api-runtime-sandbox" />[`api.runtime.sandbox`](/plugins/sdk-runtime/agent#api-runtime-sandbox)
- <a id="api-runtime-nodes" />[`api.runtime.nodes`](/plugins/sdk-runtime/gateway-and-nodes#api-runtime-nodes)
- <a id="api-runtime-tts" />[`api.runtime.tts`](/plugins/sdk-runtime/media#api-runtime-tts)
- <a id="api-runtime-mediaunderstanding" />[`api.runtime.mediaUnderstanding`](/plugins/sdk-runtime/media#api-runtime-mediaunderstanding)
- <a id="api-runtime-imagegeneration" />[`api.runtime.imageGeneration`](/plugins/sdk-runtime/media#api-runtime-imagegeneration)
- <a id="api-runtime-videogeneration" />[`api.runtime.videoGeneration`](/plugins/sdk-runtime/media#api-runtime-videogeneration)
- <a id="api-runtime-musicgeneration" />[`api.runtime.musicGeneration`](/plugins/sdk-runtime/media#api-runtime-musicgeneration)
- <a id="api-runtime-websearch" />[`api.runtime.webSearch`](/plugins/sdk-runtime/media#api-runtime-websearch)
- <a id="api-runtime-media" />[`api.runtime.media`](/plugins/sdk-runtime/media#api-runtime-media)
- <a id="api-runtime-config" />[`api.runtime.config`](/plugins/sdk-runtime/state-and-system#api-runtime-config)
- <a id="api-runtime-system" />[`api.runtime.system`](/plugins/sdk-runtime/state-and-system#api-runtime-system)
- <a id="api-runtime-events" />[`api.runtime.events`](/plugins/sdk-runtime/state-and-system#api-runtime-events)
- <a id="api-runtime-logging" />[`api.runtime.logging`](/plugins/sdk-runtime/state-and-system#api-runtime-logging)
- <a id="api-runtime-modelconfig" />[`api.runtime.modelConfig`](/plugins/sdk-runtime/models#api-runtime-modelconfig)
- <a id="api-runtime-modelauth" />[`api.runtime.modelAuth`](/plugins/sdk-runtime/models#api-runtime-modelauth)
- <a id="api-runtime-state" />[`api.runtime.state`](/plugins/sdk-runtime/state-and-system#api-runtime-state)
- <a id="api-runtime-channel" />[`api.runtime.channel`](/plugins/sdk-runtime/channel#api-runtime-channel)

## Related

- [Plugin internals](/plugins/architecture) — capability model and registry
- [SDK entry points](/plugins/sdk-entrypoints) — `definePluginEntry` options
- [SDK overview](/plugins/sdk-overview) — subpath reference

## Decision model runtime

`api.runtime.decisions` is a closure-bound optional capability for small typed
Choice, ordered Score, and Boolean-probability batches. Retained handles reject
after consumer retirement. See [decision models](/plugins/sdk-overview/capabilities#decision-models-contract-version-1)
for provider selection, lifecycle, failure handling, limits, and diagnostics.

<a id="api-runtime-tasks" />

The former Tasks runtime is no longer available. See [removed Tasks and TaskFlow APIs](/plugins/sdk-migration/removed-surfaces#tasks-and-taskflow-apis-removed) for native-owner alternatives.

### Bounded stale reads

`openclaw/plugin-sdk/collection-runtime` exports `createStaleWhileRevalidateCache`
for metadata readers. It coalesces refreshes, bounds retained entries and active
loads, and returns `{ value, stale }`. Loads retain their credential and service authority checks before external requests.
Revalidate each caller before delivering any result.
`allowStale: false` waits for freshness; `refresh: true` replaces an older load.
`clear()` retires pending cache publications. Cache keys must include the owning
identity or revision; the cache never provides authorization.
