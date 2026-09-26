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

## What each page covers

- [Config and utilities](/plugins/sdk-runtime/config-and-utilities) — runtime config reads and writes, plus the shared process, error, and model-picker utilities.
- [Agent and sessions](/plugins/sdk-runtime/agent) — agent identity, directories, session store, transcripts, and sandbox authority.
- [Model helpers](/plugins/sdk-runtime/models) — host-owned completions, model-selection policy, and provider auth resolution.
- [Background work](/plugins/sdk-runtime/background-work) — hook agent turns, subagent runs, and Task Flow record binding.
- [Gateway and nodes](/plugins/sdk-runtime/gateway-and-nodes) — in-process Gateway requests, paired node invocation, and Gateway service events.
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
| `api.runtime.tasks`              | [Background work](/plugins/sdk-runtime/background-work#api-runtime-tasks)       |
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

Context engines selected by an admitted turn remain owned through that turn's
commit and engine disposal. Replacing an enabled plugin waits for those consumers
to close before registering its successor. Disabling or removing a plugin can
report their cleanup as deferred; starting engine disposal closes normal engine
callbacks while cleanup finishes.

Replacement validates metadata and configuration first, then stops services and
channels, drains admitted work, runs `gateway_stop`, and disposes the old instance
before invoking the new registration. Pre-publication failure triggers automatic
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

SDK helpers that return bare results retain their resources until the owning
host closes. Callers do not need to dispose those results; see
[Prepared simple completions](/plugins/sdk-runtime/models#prepared-simple-completions).

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
- <a id="api-runtime-tasks" />[`api.runtime.tasks`](/plugins/sdk-runtime/background-work#api-runtime-tasks)
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
