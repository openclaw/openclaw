---
summary: "Plugin internals: capability model, ownership, contracts, load pipeline, and runtime helpers"
read_when:
  - Building or debugging native OpenClaw plugins
  - Understanding the plugin capability model or ownership boundaries
  - Working on the plugin load pipeline or registry
  - Implementing provider runtime hooks or channel plugins
title: "Plugin internals"
sidebarTitle: "Architecture"
---

This is the **deep architecture reference** for the OpenClaw plugin system. For practical guides, start with one of the focused pages below.

<CardGroup cols={2}>
  <Card title="Install and use plugins" icon="plug" href="/tools/plugin">
    End-user guide for adding, enabling, and troubleshooting plugins.
  </Card>
  <Card title="Building plugins" icon="rocket" href="/plugins/building-plugins">
    First-plugin tutorial with the smallest working manifest.
  </Card>
  <Card title="Channel plugins" icon="comments" href="/plugins/sdk-channel-plugins">
    Build a messaging channel plugin.
  </Card>
  <Card title="Provider plugins" icon="microchip" href="/plugins/sdk-provider-plugins">
    Build a model provider plugin.
  </Card>
  <Card title="SDK overview" icon="book" href="/plugins/sdk-overview">
    Import map and registration API reference.
  </Card>
</CardGroup>

## Public capability model

Capabilities are the public **native plugin** model inside OpenClaw. Native plugins can register one or more capability types:

| Capability             | Registration method                              | Example plugins                                             |
| ---------------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| Text inference         | `api.registerProvider(...)`                      | `anthropic`, `openai`                                       |
| CLI inference backend  | `api.registerCliBackend(...)`                    | `anthropic`, `openai`                                       |
| Embeddings             | `api.registerEmbeddingProvider(...)`             | Provider-owned vector plugins                               |
| Speech                 | `api.registerSpeechProvider(...)`                | `elevenlabs`, `microsoft`                                   |
| Realtime transcription | `api.registerRealtimeTranscriptionProvider(...)` | `openai`                                                    |
| Realtime voice         | `api.registerRealtimeVoiceProvider(...)`         | `google`, `openai`                                          |
| Media understanding    | `api.registerMediaUnderstandingProvider(...)`    | `google`, `openai`                                          |
| Transcripts source     | `api.registerTranscriptSourceProvider(...)`      | `discord`, `google-meet`, `teams-meetings`, `zoom-meetings` |
| Image generation       | `api.registerImageGenerationProvider(...)`       | `fal`, `google`, `openai`                                   |
| Music generation       | `api.registerMusicGenerationProvider(...)`       | `fal`, `google`, `minimax`                                  |
| Video generation       | `api.registerVideoGenerationProvider(...)`       | `fal`, `google`, `qwen`                                     |
| Web fetch              | `api.registerWebFetchProvider(...)`              | `firecrawl`                                                 |
| Web search             | `api.registerWebSearchProvider(...)`             | `brave`, `firecrawl`, `google`                              |
| Channel / messaging    | `api.registerChannel(...)`                       | `matrix`, `msteams`                                         |
| Gateway discovery      | `api.registerGatewayDiscoveryService(...)`       | `bonjour`                                                   |
| Migration              | `api.registerMigrationProvider(...)`             | `migrate-claude`, `migrate-hermes`                          |

<Note>
A plugin that registers only hooks is **hook-only**. Plugins with tools, commands, background services, or routes but no capabilities are **non-capability** plugins. Both patterns remain supported; gateway discovery is an explicit capability listed above.
</Note>

### External compatibility stance

The capability model is landed in core and used by bundled/native plugins today, but external plugin compatibility still needs a tighter bar than "it is exported, therefore it is frozen."

| Plugin situation                                  | Guidance                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Existing external plugins                         | Keep hook-based integrations working; this is the compatibility baseline.                        |
| New bundled/native plugins                        | Prefer explicit capability registration over vendor-specific reach-ins or new hook-only designs. |
| External plugins adopting capability registration | Allowed, but treat capability-specific helper surfaces as evolving unless docs mark them stable. |

Capability registration is the intended direction. Legacy hooks remain the safest no-breakage path for external plugins during the transition. Exported helper subpaths are not all equal — prefer narrow documented contracts over incidental helper exports.

### Plugin shapes

OpenClaw classifies every loaded plugin into a shape based on its actual registration behavior (not just static metadata):

<AccordionGroup>
  <Accordion title="plain-capability">
    Registers exactly one capability type (for example a provider-only plugin like `arcee` or `chutes`).
  </Accordion>
  <Accordion title="hybrid-capability">
    Registers multiple capability types (for example `openai` owns text inference, speech, media understanding, and image generation).
  </Accordion>
  <Accordion title="hook-only">
    Registers only hooks (typed or custom), no capabilities, tools, commands, or services.
  </Accordion>
  <Accordion title="non-capability">
    Registers tools, commands, services, or routes but no capabilities.
  </Accordion>
</AccordionGroup>

Use `openclaw plugins inspect <id>` to see a plugin's shape and capability breakdown. See [CLI reference](/cli/plugins#inspect) for details.

### Compatibility signals

`openclaw doctor`, `openclaw plugins inspect <id>`, `openclaw status --all`, and `openclaw plugins doctor` surface these compatibility notices:

| Signal                                     | Meaning                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **config valid**                           | Config parses fine and plugins resolve                                                                        |
| **hook-only** (info)                       | Plugin registers only hooks; a supported path, but not migrated to capability registration yet                |
| **deprecated memory-embedding API** (warn) | Non-bundled plugin uses the old memory-specific embedding provider API instead of `registerEmbeddingProvider` |
| **hard error**                             | Config is invalid or plugin failed to load                                                                    |

None of the advisory/warn signals break your plugin today. These signals also appear in `openclaw status --all` and `openclaw plugins doctor`.

## Architecture overview

OpenClaw's plugin system has four layers:

<Steps>
  <Step title="Manifest + discovery">
    OpenClaw finds candidate plugins from configured paths, workspace roots, global plugin roots, and bundled plugins. Discovery reads native `openclaw.plugin.json` manifests plus supported bundle manifests first.
  </Step>
  <Step title="Enablement + validation">
    Core decides whether a discovered plugin is enabled, disabled, blocked, or selected for an exclusive slot such as memory.
  </Step>
  <Step title="Runtime loading">
    Native OpenClaw plugins are loaded in-process and register capabilities into a central registry. Managed instances load JavaScript through Node and compile TypeScript source when needed. Compatible bundles are normalized into registry records without importing runtime code.
  </Step>
  <Step title="Surface consumption">
    The rest of OpenClaw reads the registry to expose tools, channels, provider setup, hooks, HTTP routes, CLI commands, and services.
  </Step>
</Steps>

For plugin CLI specifically, root command discovery is split in two phases:

- parse-time metadata comes from `registerCli(..., { descriptors: [...] })`
- the real plugin CLI module can stay lazy and register on first invocation

That keeps plugin-owned CLI code inside the plugin while still letting OpenClaw reserve root command names before parsing.

The important design boundary:

- manifest/config validation should work from **manifest/schema metadata** without executing plugin code
- native capability discovery may load trusted plugin entry code to build a non-activating registry snapshot
- native runtime behavior comes from the plugin module's `register(api)` path with `api.registrationMode === "full"`

That split lets OpenClaw validate config, explain missing/disabled plugins, and build UI/schema hints before the full runtime is active.

### Plugin metadata snapshot and lookup table

One `PluginCache` starts on the first plugin metadata access, including CLI preflight before Gateway startup, and fills progressively as metadata and artifacts are needed. Gateway startup retains that owner and builds its immutable `PluginMetadataSnapshot`. The snapshot includes plugin metadata from all configured agent workspaces, including disabled plugins, with source precedence and workspace provenance preserved. It stores the installed plugin index, manifest registry, manifest diagnostics, owner maps, and a plugin id normalizer. Package contents and lazily loaded module exports belong to other typed views of the same cache, not the snapshot itself.

Plugin-aware config validation, startup auto-enable, and Gateway plugin bootstrap consume that snapshot instead of rebuilding manifest/index metadata independently. `PluginLookUpTable` is derived from the same snapshot and adds the startup plugin plan for the current runtime config.

Channel setup catalogs retain the requested workspace and load-path scope, including raw plugin shadows, so trust filtering can select the appropriate installed alternative.

After startup, runtime readers reuse that inventory without filesystem discovery, manifest rereads, or freshness checks. Narrow plugin selections are in-memory views of the same inventory. Changing an account or an agent's run workspace does not invalidate it. Explicit plugin lifecycle operations prepare a new inventory for installs, updates, removals, source or manifest edits, and discovery-root changes before publishing it to the running Gateway.

Plugin reload reconciles config watcher events after asynchronous metadata preparation. An unchanged source event does not cancel the operation; newer writes or changed config, install records, or source ownership still supersede it.

Legacy session-key migration selects plugins that declare that capability before checking channel presence. Owners already eligible under migration policy do not need a channel-presence probe. Scoped selections probe persisted credentials only for their channel owners, so unrelated authentication modules stay unloaded during Doctor repairs. This credential scope does not limit environment-based presence signals: configured channels with missing plugins still produce installation and recovery hints.

Model-id normalization policies are prepared with each snapshot or narrowed view. Model selection, catalogs, and runtime normalization carry that view forward instead of rebuilding policies from its plugin list. An empty view remains authoritative and cannot inherit policies from a broader process snapshot.

Fleet model-runtime preparation captures one immutable config and authored-source view per build. Plugin argument handling, activation fingerprints, and agent lookups reuse those captured facts across agents. Dynamic model hooks still receive each agent's directory, workspace, and model registry. Preparation yields to the event loop between agents so Gateway requests can run during a large fleet build; config refresh creates a new capture. Existing installations need no configuration changes or migration.

The snapshot and lookup table keep repeated startup decisions on the fast path:

- channel ownership
- startup plugin planning
- startup plugin ids
- provider and CLI backend ownership
- setup provider, command alias, model catalog provider, and manifest contract ownership
- plugin config schema and channel config schema validation
- startup auto-enable decisions

Startup and hot replacement share one prepared registry publisher and the same inventory across all configured agent workspaces. Reload preserves workspace provenance so an unchanged linked plugin is not replaced when another plugin changes. Replacement retains unchanged plugin instances and validates candidate metadata before draining affected services and channels. Reordering object keys in equivalent metadata or settings does not replace a registration; changed values, ordered lists, and explicit reload requests still do. It stops and disposes the previous registration before registering its replacement, then publishes runtime methods and metadata together. Connected clients refresh their plugin capabilities after publication. If replacement fails before publication and cleanup succeeds, recovery registers captured previous code and configuration with fresh resource ownership. A failure after publication reports the committed generation. Plugin runtime imports remain lazy; retaining metadata does not activate every discovered plugin.

Replacement reserves the affected instance even when agent turns or unfinished cleanup retain it. The prepared-model replacement gate holds new runs while already admitted runs finish using their original callbacks. New retained work cannot acquire the old instance, so overlapping arrivals cannot continually postpone replacement. Detailed readiness and logs report the retained-work count and drain deadline; the final RPC receipt reports application and any drain notices. Reload from the instance's own active callback still fails during preparation to avoid waiting on itself. Idle prepared publications do not block replacement.

Retained work and in-flight calls share a 60-second pre-stop budget. Retained runs finish before their callbacks close; sidecars release their capability consumers before the remaining finite consumers drain. Replacement then pauses ordinary calls before stopping services and channels. Idle service and channel custody stops later with its owners. If work does not finish, the reload fails once, resumes admission, and clears the reload status; the previous plugin generation keeps serving. The deadline does not cancel agent runs or permit disposal of unfinished writes. Retry `openclaw plugins reload <id>` after that work finishes. Successful publication logs the applied replacement and emits `plugins.changed`.

A provider or harness plugin load failure remains recorded in its runtime generation. It makes that plugin unavailable without superseding the generation or blocking models that use healthy plugins. Inspect the failing owner with `openclaw plugins inspect <id> --runtime --json`. Use `openclaw doctor --fix` for supported installation repairs, or fix the reported problem in plugin code, then request `plugins.reload` through the admin Gateway API to load the repaired plugin.

Read-only model validation, effective tool inventory, and isolated model probes acquire their own registrations when they need executable provider or harness hooks. Concurrent callers share the prepared generation, and its lifecycle disposers run after the final borrower and any unfinished preparation or catalog work settle. Cancellation does not close a registration while its callback is still running. Process shutdown revokes these registry views before joining their remaining work and disposal. Catalog reads that need only metadata do not acquire these executable registrations. Effective tool inventory prepares only configured and session-selected model facts, including captured catalogs from enabled providers; it does not refresh the full model catalog. Session selections do not change the configured model picker.

Each plugin service startup attempt owns one cleanup operation, including failed starts. Hot replacement observes candidate startup and service cleanup with five-second deadlines. Candidate startup failure rejects the replacement. Replacing a loaded plugin requires successful cleanup before another registration can acquire its resources; pending cleanup or a cleanup error can therefore reject replacement and prevent automatic recovery. A pending startup retains its resources until it finishes and its one stop operation settles. Plugin removal can report deferred cleanup; Gateway shutdown joins that work before releasing the plugin's resources. Disposal stops new registered calls while physical cleanup finishes. Service cleanup is not invoked a second time merely because an observer timed out. If a command catalog refresh also stopped unchanged channels, failed replacement resumes those healthy registrations while the failed plugin remains fenced.

A failed replacement automatically tries to restore the previous code and configuration. If its channels have already stopped, recovery waits up to 60 seconds for pending service cleanup and admitted work, retrying settlement observation with one-, two-, then four-second backoff. Each observation remains bounded by the five-second cleanup deadline and the remaining recovery window. Only service-stop observer timeouts qualify for this wait; channel-stop failures, rejected service cleanup, and failed candidate cleanup still prevent recovery. The wait joins the original service stop promises, including services whose shared stop deadline was already exhausted. After cleanup and work settle successfully, recovery disposes the old registration, registers its captured code with fresh resource ownership, and restarts its channels. Manually stopped accounts stay stopped. A timeout never grants another registration ownership of an unfinished write's resources, and retries do not repeat service stop or resource disposal. Uncommitted failures also attempt to republish the prepared model runtime against the previous config, even when plugin recovery fails or cannot safely run, unless the Gateway is shutting down.

When recovery cannot safely finish, the operation settles as failed and releases its channel reload pauses. Channel health reads retain captured account facts without invoking unavailable plugin code; healthy registrations can restart normally. Detailed readiness reports `failing: ["plugin-reload"]` with the affected plugin IDs and an actionable recovery reason, instead of leaving an indefinite "reloading" state. Retry `openclaw plugins reload <id>` after admitted work and pending cleanup settle, or restart the Gateway. Permanent cleanup failures still prevent another registration from acquiring those resources.

A later reload can retry after pending cleanup completes successfully, without capturing code from the disposed instance again. If draining fails after services or channels stop but before disposal starts, the quiesced registration retains its original loader for the next reload's recovery capture; ordinary plugin calls remain closed when recovery fails. Rejected replacements and failed recovery registrations retain the same cleanup barrier. Recovery preserves existing error records as diagnostics without executing their code. It never substitutes current package files for an already retired registration whose captured source has been released.

Missing captured source files produce a replacement warning instead of preventing a fresh plugin load. Recovery snapshots must contain every previously captured input, including companion files. If replacement then fails, recovery restores only plugins with available captured code; it does not substitute changed installed files for a missing snapshot. Existing call-drain and resource-cleanup requirements still apply.

Gateway shutdown also joins actual harness, MCP, LSP, embedding, and media cleanup after their initial grace periods. When clearing the active registry, plugin host cleanup can advance to later hooks after a timeout, but registry resets and shared database closure wait for its actual completion. These waits preserve resources for cleanup; they do not restore a retired plugin's runtime authority.

Executable CLI cleanup reports each disposer that exceeds five seconds and proceeds with later cleanup without canceling the pending work. On macOS with Node's system CA support enabled, automatic exit after command completion waits for this pending cleanup to finish. Explicit command exit requests and the update exit watchdog retain their bounded behavior.

Standalone plugin and Codex supervision MCP stdio services retain their discovered registrations through accepted tool work, harness cleanup, and nested SDK provider lookups. Terminal shutdown cancels and joins handlers before releasing these registrations and awaiting their resource disposers. Transport-close and registration-disposal failures reach the serving caller. Programmatic servers created from supplied tools leave those resources with the caller; closing and reconnecting the same server does not dispose them.

Hot registry publication does not wait for retired host cleanup; terminal shutdown also joins cleanup already started by earlier registry replacements before resetting shared state. Activation and rollback apply only to their captured registry version. An activation superseded by a lifecycle callback reports an error.

The cache rule is documented in [Plugin architecture internals](/plugins/architecture-internals#plugin-cache-boundary): Gateway retains one cache generation, while explicit management operations use isolated generations of the same cache. There are no wall-clock TTLs for Gateway metadata.

Install, update, registry refresh, and doctor flows may read fresh package metadata to validate their changes. A management snapshot or installed-index write alone does not replace the running Gateway's inventory: the Gateway lifecycle owner must prepare and publish it. Runtime flows use their selected snapshot or lookup table instead of falling back to cold management paths.

### Runtime instance and source lifetime

A managed runtime instance owns its module results, registered callables, and
runtime-store slots. With Node's synchronous module hooks, it also owns a captured
source artifact. Package plugins capture their package inputs when the instance
is created. Standalone files capture their entry and statically known inputs
without copying the surrounding workspace. Compiled bundled runtime and setup
modules share the host's code identity; each inventory still owns its registered
callbacks and cleanup. Replacing that compiled code requires a build and Gateway
restart. Conditional package aliases retain their package metadata, and native
Node conditions select the target from that captured metadata. Legacy packages
without an exports map also prefetch their existing main or index entry as raw
bytes; this can read a large native entry, but does not execute unselected code.
The selected package's remaining body is captured before execution.
Dependency links retain existing nested installation locations. Dependencies installed
beside a package remain siblings in the capture, including optional platform packages
whose native assets are read through relative filesystem paths. Other ancestor
dependencies link at the captured package root. Capture does not add `node_modules` beside
individual source files, so native-addon loaders can still locate their package
root and its build assets.

Each captured generation links the selected host `openclaw` package so Workers
and child processes started from its modules can resolve the host SDK. This link
does not depend on the main thread's module hooks and is recreated during recovery.
Imports of resolved SDK file URLs and absolute paths keep the same host identity;
they do not create a selective copy of the host package or its runtime chunks.
Snapshot cleanup and update source inspection do not descend through these links
into the host package.

After the existing runtime, setup, or executable-discovery checks admit an entry,
its instance captures imported shared files and dependency modules on demand.
Relative, absolute, and file-URL imports use captured files; TypeScript dependency
entries compile in their own package scope. Metadata and install inspection remain
confined and do not acquire executable shared inputs.

Executable loading can follow a shared-module link by capturing its selected
module separately. Cold source snapshots still reject links outside the plugin
root, so deferred install batches and install-digest settlement require those
inputs to be packaged as dependencies. Linked non-module resources outside the
plugin root are not captured by this module-loading path.

A first-demand `import()` or `require()` can observe later source edits; captured
metadata and entry bytes remain unchanged. The initial source digest covers the
creation-time capture; later inputs extend explicit source-current checks without
changing that digest. Invalid optional package metadata fails only when selected.
Module acquisition uses the instance's current admission, and disposal closes
further capture.
Runtime and setup retirement use the existing five-second instance shutdown budget.
If calls, retained consumers, or cleanup exceed that budget, logical retirement
returns a forced-retirement diagnostic with the still-running call and consumer
counts. Ordinary invocation authority closes and late successful results are
refused. Physical cleanup continues asynchronously: captured files and module
resolvers remain until calls, consumers, and cleanup tails actually settle.
An explicitly retained consumer keeps its admitted turn and cleanup authority until
its host closes or releases it. Its callbacks and late results are refused after release.
Shared writable state stays owned until its cleanup finishes; late cleanup
failures remain failures of the resource handoff. Web provider
descriptors keep their registration identity; runtime projections bind their
factories and returned tools to the selected plugin instance. Synchronous source
inspection and failed capture still clean up before returning.

Default source captures live under
`<stateDir>/tmp/plugin-captures/<instanceId>/captures/`, with a random instance ID
and an empty SQLite coordinator held for that instance's lifetime. Gateway
metadata and its source captures retain the same process-local instance; a
concurrent CLI process owns a separate instance. Releasing one capture cannot
retire another capture or a still-running metadata owner.
The shared cleanup timer does not retain the first command's invocation context.
The managed `tmp/plugin-captures` subtree is excluded from source snapshots when
the state directory is inside a plugin's source directory. Recovery can still
load a preserved source package from within that subtree.

This follows the native lifetime-token pattern used for
[interrupted SQLite snapshots](/reference/database-schemas/integrity-and-recovery).
Executable CLI commands retire their plugin inventory through the existing invocation
resource scope on success and failure. Inventory adopted by Gateway publication
remains with Gateway metadata retirement. At process exit, the capture owner
synchronously retires any remaining instance that holds this process's native
custody, including explicit exits and CLI-handled signals. Forced termination
still relies on startup reclamation. Snapshot
cleanup owns SQLite staging files, while plugin cleanup owns this capture subtree.
Reclamation removes captured
payload before its coordinator so a partial deletion remains retryable.

Startup and hourly cleanup inspect this owned subtree. An instance becomes
eligible after one hour, but age alone never authorizes removal: cleanup must
also acquire its native coordinator, proving that no producer retains custody.
Process exit releases the native lock even after a forced termination. PID
names, process probes, and PID-reuse guesses are not used; a numeric PID cannot
identify a producer across containers sharing a temporary directory. Contention,
unreadable entries, and symlinks preserve files. An aged instance left without a
coordinator by interrupted allocation or older partial cleanup is reclaimed after
a successful rename probe. Allocation acquires the coordinator before creating
payload, and disposal removes payload before its coordinator.
Removal remains asynchronous and advisory. This subtree is excluded from state
backups because its captured package bytes are reconstructible.

Metadata retention does not create directories until a source capture is needed.
If the state directory cannot accept captures, loading falls back to an isolated
system-temporary instance and reports a warning. Normal disposal still removes
that instance; automatic cleanup does not scan unrelated system-temporary roots.
There is no total disk quota, and an active instance may legitimately exceed the
one-hour cleanup grace period.

Startup and hourly cleanup also reclaim tokenless `openclaw-plugin-build-*` and
`openclaw-model-catalog-*` roots in the selected state's temporary directory and
the current system temporary directory. Roots must be older than one hour and
have no coordinator. A complete process census that finds another OpenClaw
producer preserves legacy roots. When the census is unavailable, including on
Windows, cleanup uses age and a rename probe instead; sharing violations leave
locked roots for a later cycle. This is best-effort cleanup of reconstructible
legacy scratch, not proof that an older producer has stopped using it.

Older `openclaw-plugin-build-*` directories in the system temporary directory
have no coordinator proving whether their producer is still alive. Doctor reports
tokenless `openclaw-plugin-build-*` and `openclaw-model-catalog-*` roots under the
state temporary directory, `~/.openclaw/tmp` even when another state directory is
selected, the current system temporary directory, `/tmp` on
POSIX hosts, and recorded managed-service `TMPDIR` locations. It deduplicates
directory aliases and reports each capture's path and regular-file size without
following links inside captures. Catalog roots include all nested
`openclaw-plugin-build-*` trees in their reported size and removal receipt.

`openclaw doctor --fix` reclaims these legacy roots only while Doctor holds Gateway
maintenance and a complete host process census finds no other OpenClaw producer.
The rule rechecks both conditions before each removal and prints a receipt listing
the paths removed and their sizes. A live sibling, unavailable census, or missing
maintenance authority leaves the captures in place with an explanatory message.
Captures created or changed during the current process and token-bearing captures
remain untouched. Linux and macOS preserve native argument boundaries when
inspecting processes. macOS can also identify native system services
under another user by their kernel executable path and valid Apple platform signature; unavailable arguments for
other live processes keep cleanup blocked with a reason.
On hosts without a complete process census (including
Windows and recognized container environments), Doctor reports legacy
captures but skips their removal. For a container sharing the host's temporary
directory, run maintenance on the host after stopping its OpenClaw containers.
Doctor's maintenance repair remains separate from runtime reclamation: its
broader inventory includes old service temporary locations the current runtime
does not use. Modern captures retain their custody-token cleanup.

Configured Gateway agents share one model-catalog worker per plugin-inventory
lifetime. Agent and authentication facts belong to each task; plugin registrations
and captured source remain with the shared inventory. Standalone hosts that supply
their own environment retain an isolated catalog worker for that environment.
Provider-discovery entries use the exact selected runtime instance's captured
source when it is already loaded, so discovery does not create a second copy of
the same plugin package. Standalone discovery keeps its own setup lifetime.
Each worker retains one plugin registration context, shared by agents with the
same configuration, environment, plugin inventory, and loader workspace. Agent
credentials and configured model facts travel with each request; catalog jobs do
not rebuild the agent workspace. Discovery reuses the registrations already
acquired by that context. Replacement releases them after admitted work settles.
Successfully disposed registrations leave their plugin caches.

Catalog observation is passive. Inventory requests can ask the catalog owner to
renew expired providers while returning its accepted rows. Chat metadata and
session projections only observe publication, so a refresh cannot schedule itself
through its own notifications. Selected native-model discovery has an independent
acquisition owner and does not wait for provider inventory renewal. Both owners
merge their results with the latest accepted counterpart before publication.
Catalog workers use a 512 MiB V8 old-generation limit rather than inheriting the
Gateway's default heap budget. Explicit process-wide heap flags override this
limit; native and external allocations are outside it.

Catalog and authentication refresh tasks carry the host's prepared Claw consent
provenance. Worker config reconstruction and provider imports consume these facts
without opening or copying the shared state database. Host config publication and
Doctor retain their existing provenance refresh and artifact-preserving inspection
paths; stored data, schemas, and update/rollback behavior are unchanged.

Credential persistence publishes fresh shared-store ownership before credential
discovery. Login and explicit auth refresh join the credential owner's publication
instead of creating another catalog generation for the same change.

Model-catalog workers keep their captured plugin files in a worker-owned directory
under the same managed capture instance, with custody retained by their producer.
The parent removes any remaining captures after that worker exits,
including cancellation and crashes. Files remain available while the worker is
running, and retiring one worker does not remove another generation's captures.
If the whole Gateway is killed, the existing hourly cleanup reclaims the abandoned
instance only after acquiring its released SQLite coordinator.
Cancellation releases compute capacity after the worker exits; terminal shutdown
also waits for file cleanup. Failed file removal is reported as a cleanup warning.

Loading metadata alone does not execute every plugin, and registration remains
synchronous. Synchronously loaded TypeScript entries and their synchronous
TypeScript imports retain Jiti's CommonJS compilation behavior, including `.mts`
and `.mtsx` entries. Node evaluates the captured output. Keep top-level await out
of synchronous entrypoints; start asynchronous work through lifecycle callbacks
or a later dynamic import.

Dynamic TypeScript imports preserve asynchronous CommonJS execution, including
top-level await and `module.exports`, while source loaded from native JavaScript
follows Node's module format. The first evaluation fixes that mode for the
instance; resolving a module alone does not evaluate it. Source
`import.meta.resolve` retains Jiti's optional parent URL and resolution options,
including custom conditions and `try`. The one-argument resolver uses the
source's directory and package scope.
Entries loaded from captured source retain evaluation failures for their instance
instead of retrying through another loader. Core-shipped JavaScript and libraries
loaded outside a captured plugin instance keep their existing native/Jiti loading
behavior.

The host Plugin SDK always stays on the host's native module graph, including
when Jiti compiles a plugin entry. SDK aliases use canonical filesystem paths so
symlinked checkouts cannot create another host owner. The running host selects
source or built SDK modules; a plugin's file extension does not select a second
SDK graph. Source hosts need a native TypeScript loader such as the repository's
tooling preload. An SDK that cannot load natively fails instead of being evaluated
again by the plugin transformer. Plugin reloads may create new instances of the
plugin's private code, while existing and replacement plugins share host SDK
identity and authority.

Captured packages also retain a link to the selected host installation so child
workers and processes can import its public SDK. These separate isolates use the
installation's normal package exports; they do not inherit the parent's source
aliases or authority. Capture disposal removes the link, never the host package.

Managed TypeScript filename metadata (`import.meta.url`, `import.meta.filename`,
`import.meta.dirname`, `__filename`, and `__dirname`) identifies the captured
source so relative asset reads stay within that generation. Node executes compiled
JavaScript from a separate directory; its module URLs and CommonJS cache keys can
differ from the source filenames.

Bun 1.4.2 uses its native/Jiti loader with a separate captured source artifact for
each managed instance. Reload prepares fresh TypeScript entries and helpers while
existing consumers retain their old instance. Disposal removes that instance's
captured cache records and files without evicting its replacement or the host SDK.
Native imports and Jiti imports retain their respective package conditions.

Bun needs local package import/export targets to exist before native resolution.
Selective captures therefore acquire existing files matched by those declarations,
including conditional branches and wildcard targets, before evaluation. Unselected
source remains raw bytes; its code and TypeScript configuration are not evaluated.
This can read more files at startup than Node's demand-driven capture. Other
deferred imports still acquire source on first use through the instance's current
admission; already prepared modules need no new acquisition.

When using Jiti's TypeScript path settings, keep the original tsconfig files and
configuration dependencies available while the plugin is active. Loaded modules
retain their selected path mappings; previously unvisited modules may read those
configuration files on first use. Newly loaded instances select the current
path settings.

Registry retirement revokes managed execution separately from physical resource
release. An acquired inspection can release its execution authority while a
borrower still holds the underlying registration resources; the last physical
claim owns their disposal, including a cleanup work scope that remains usable
after the releasing request has ended. Bare SDK provider results retain their own instance
consumer, so their callbacks remain usable until the owning SDK host closes.
That host joins admitted callback work before releasing consumers and resources;
releasing the inspection still prevents new borrows. Gateway shutdown keeps shared dependencies
until the owners that still need them have joined. These ownership rules do not
make native plugins a sandbox or automatically close plugin-created resources.
See [Plugin lifecycle and cleanup](/plugins/sdk-runtime#plugin-lifecycle-and-cleanup)
for the plugin author's cleanup contract.

An admitted agent turn keeps its original context engine through accepted commit
and engine disposal. Reload can report deferred cleanup while that turn finishes.
Starting engine disposal closes its normal callbacks immediately; the engine's
cleanup remains owned until it settles.

### Activation planning

Activation planning is part of the control plane. Callers can ask which plugins are relevant to a concrete command, provider, channel, route, agent harness, or capability before loading broader runtime registries.

The planner keeps current manifest behavior compatible:

- `activation.*` fields are explicit planner hints
- `providers`, `channels`, `commandAliases`, `setup.providers`, `contracts.tools`, and hooks remain manifest ownership fallback
- the ids-only planner API stays available for existing callers
- the plan API reports reason labels so diagnostics can distinguish explicit hints from ownership fallback

<Warning>
Do not treat `activation` as a lifecycle hook or a replacement for `register(...)`. It is metadata used to narrow loading. Prefer ownership fields when they already describe the relationship; use `activation` only for extra planner hints.
</Warning>

### Channel plugins and the shared message tool

Channel plugins do not need to register a separate send/edit/react tool for normal chat actions. OpenClaw keeps one shared `message` tool in core, and channel plugins own the channel-specific discovery and execution behind it.

The current boundary is:

- core owns the shared `message` tool host, prompt wiring, session/thread bookkeeping, and execution dispatch
- channel plugins own scoped action discovery, capability discovery, and any channel-specific schema fragments
- channel plugins own provider-specific session conversation grammar, such as how conversation ids encode thread ids or inherit from parent conversations
- channel plugins execute the final action through their action adapter

For channel plugins, the SDK surface is `ChannelMessageActionAdapter.describeMessageTool(...)`. That unified discovery call lets a plugin return its visible actions, capabilities, and schema contributions together so those pieces do not drift apart.

Message action names use a deliberately closed, core-owned vocabulary so every transport can render every action. Plugins add action names through a core PR; runtime registration is intentionally unsupported.

When a channel-specific message-tool param carries a media source such as a local path or remote media URL, the plugin should also return `mediaSourceParams` from `describeMessageTool(...)`. Core uses that explicit list to apply sandbox path normalization and outbound media-access hints without hardcoding plugin-owned param names. Prefer action-scoped maps there, not one channel-wide flat list, so a profile-only media param does not get normalized on unrelated actions like `send`.

Core passes runtime scope into that discovery step. Important fields include:

- `accountId`
- `currentChannelId`
- `chatType` (`direct`, `group`, or `channel` when the inbound route establishes it)
- `currentThreadTs`
- `currentMessageId`
- `sessionKey`
- `sessionId`
- `agentId`
- trusted inbound `requesterSenderId`

That matters for context-sensitive plugins. A channel can hide or expose message actions based on the active account, current room/thread/message, authoritative conversation type, or trusted requester identity without hardcoding channel-specific branches in the core `message` tool. Treat `chatType` as discovery scope supplied by the current inbound route, not something to infer again from an opaque channel id; it is absent when that route did not establish the conversation type.

This is why embedded-runner routing changes are still plugin work: the runner is responsible for forwarding the current chat/session identity into the plugin discovery boundary so the shared `message` tool exposes the right channel-owned surface for the current turn.

For channel-owned execution helpers, channel plugins should keep the execution runtime inside their own plugin modules. Core no longer owns the Discord, Slack, Telegram, or WhatsApp message-action runtimes under `src/agents/tools`. We do not publish separate `plugin-sdk/*-action-runtime` subpaths, and those plugins should import their own local runtime code directly from their plugin-owned modules.

The same boundary applies to provider-named SDK seams in general: core should not import channel-specific convenience barrels for Discord, Signal, Slack, WhatsApp, or similar plugins. If core needs a behavior, either consume the bundled plugin's own `api.ts` / `runtime-api.ts` barrel or promote the need into a narrow generic capability in the shared SDK.

Bundled plugins follow the same rule. A bundled plugin's `runtime-api.ts` should not re-export its own branded `openclaw/plugin-sdk/<plugin-id>` facade. Those branded facades remain compatibility shims for external plugins and older consumers, but bundled plugins should use local exports plus narrow generic SDK subpaths such as `openclaw/plugin-sdk/channel-policy`, `openclaw/plugin-sdk/runtime-store`, or `openclaw/plugin-sdk/webhook-ingress`. New code should not add plugin-id-specific SDK facades unless the compatibility boundary for an existing external ecosystem requires it.

For polls specifically, there are two execution paths:

- `outbound.sendPoll` is the shared baseline for channels that fit the common poll model
- `actions.handleAction("poll")` is the preferred path for channel-specific poll semantics or extra poll parameters

Core now defers shared poll parsing until after plugin poll dispatch declines the action, so plugin-owned poll handlers can accept channel-specific poll fields without being blocked by the generic poll parser first.

See [Plugin architecture internals](/plugins/architecture-internals) for the full startup sequence.

## Capability ownership model

OpenClaw treats a native plugin as the ownership boundary for a **company** or a **feature**, not as a grab bag of unrelated integrations.

That means:

- a company plugin should usually own all of that company's OpenClaw-facing surfaces
- a feature plugin should usually own the full feature surface it introduces
- channels should consume shared core capabilities instead of re-implementing provider behavior ad hoc

<AccordionGroup>
  <Accordion title="Vendor multi-capability">
    `google` owns text inference, CLI backend, embeddings, speech, realtime voice, media understanding, image/music/video generation, and web search. `openai` owns text inference, embeddings, speech, realtime transcription, realtime voice, media understanding, image/video generation. `minimax` owns text inference plus media understanding, speech, image/music/video generation, and web search.
  </Accordion>
  <Accordion title="Vendor single-capability">
    `arcee` and `chutes` own text inference only; `microsoft` owns speech only. A vendor plugin can stay this narrow until it needs to cover more of that vendor's surface.
  </Accordion>
  <Accordion title="Feature plugin">
    `voice-call` owns call transport, tools, CLI, routes, and Twilio media-stream bridging, but consumes shared speech, realtime transcription, and realtime voice capabilities instead of importing vendor plugins directly.
  </Accordion>
</AccordionGroup>

The intended end state is:

- a vendor's OpenClaw-facing surface lives in one plugin even if it spans text models, speech, images, and video
- other vendors can do the same for their own surface area
- channels do not care which vendor plugin owns the provider; they consume the shared capability contract exposed by core

This is the key distinction:

- **plugin** = ownership boundary
- **capability** = core contract that multiple plugins can implement or consume

So if OpenClaw adds a new domain such as video, the first question is not "which provider should hardcode video handling?" The first question is "what is the core video capability contract?" Once that contract exists, vendor plugins can register against it and channel/feature plugins can consume it.

If the capability does not exist yet, the right move is usually:

<Steps>
  <Step title="Define the capability">
    Define the missing capability in core.
  </Step>
  <Step title="Expose through the SDK">
    Expose it through the plugin API/runtime in a typed way.
  </Step>
  <Step title="Wire consumers">
    Wire channels/features against that capability.
  </Step>
  <Step title="Vendor implementations">
    Let vendor plugins register implementations.
  </Step>
</Steps>

This keeps ownership explicit while avoiding core behavior that depends on a single vendor or a one-off plugin-specific code path.

### Capability layering

Use this mental model when deciding where code belongs:

<Tabs>
  <Tab title="Core capability layer">
    Shared orchestration, policy, fallback, config merge rules, delivery semantics, and typed contracts.
  </Tab>
  <Tab title="Vendor plugin layer">
    Vendor-specific APIs, auth, model catalogs, speech synthesis, image generation, video backends, usage endpoints.
  </Tab>
  <Tab title="Channel/feature plugin layer">
    Discord/Slack/voice-call/etc. integration that consumes core capabilities and presents them on a surface.
  </Tab>
</Tabs>

For example, TTS follows this shape:

- core owns reply-time TTS policy, fallback order, prefs, and channel delivery
- `elevenlabs`, `google`, `microsoft`, and `openai` own synthesis implementations
- `voice-call` consumes the telephony TTS runtime helper

That same pattern should be preferred for future capabilities.

### Multi-capability company plugin example

A company plugin should feel cohesive from the outside. If OpenClaw has shared contracts for models, speech, realtime transcription, realtime voice, media understanding, image generation, video generation, web fetch, and web search, a vendor can own all of its surfaces in one place:

```ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { exampleAiMedia } from "./exampleai-media.js";

export default definePluginEntry({
  id: "exampleai",
  name: "ExampleAI",
  description: "ExampleAI models and media capabilities.",
  register(api) {
    api.registerProvider({
      id: "exampleai",
      // auth/model catalog/runtime hooks
    });

    api.registerSpeechProvider({
      id: "exampleai",
      // vendor speech config — implement the SpeechProviderPlugin interface directly
    });

    api.registerMediaUnderstandingProvider({
      id: "exampleai",
      capabilities: ["image", "audio", "video"],
      describeImage: (req) => exampleAiMedia.describeImage(req),
      transcribeAudio: (req) => exampleAiMedia.transcribeAudio(req),
      describeVideo: (req) => exampleAiMedia.describeVideo(req),
    });

    api.registerWebSearchProvider({
      id: "exampleai-search",
      createTool() {
        // Return the vendor-owned web search tool.
      },
    });
  },
});
```

What matters is not the exact helper names. The shape matters:

- one plugin owns the vendor surface
- core still owns the capability contracts
- provider request translation and HTTP helpers stay in the vendor plugin
- channels and feature plugins consume `api.runtime.*` helpers, not vendor code
- contract tests can assert that the plugin registered the capabilities it claims to own

### Capability example: video understanding

OpenClaw already treats image/audio/video understanding as one shared capability. The same ownership model applies there:

<Steps>
  <Step title="Core defines the contract">
    Core defines the media-understanding contract.
  </Step>
  <Step title="Vendor plugins register">
    Vendor plugins register `describeImage`, `transcribeAudio`, and `describeVideo` as applicable.
  </Step>
  <Step title="Consumers use the shared behavior">
    Channels and feature plugins consume the shared core behavior instead of wiring directly to vendor code.
  </Step>
</Steps>

That avoids baking one provider's video assumptions into core. The plugin owns the vendor surface; core owns the capability contract and fallback behavior.

Video generation already uses that same sequence: core owns the typed capability contract and runtime helper, and vendor plugins register `api.registerVideoGenerationProvider(...)` implementations against it.

Need a concrete rollout checklist? See [Adding capabilities](/plugins/adding-capabilities).

## Contracts and enforcement

The plugin API surface is intentionally typed and centralized in `OpenClawPluginApi`. That contract defines the supported registration points and the runtime helpers a plugin may rely on.

Why this matters:

- plugin authors get one stable internal standard
- core can reject duplicate ownership such as two plugins registering the same provider id
- startup can surface actionable diagnostics for malformed registration
- contract tests can enforce bundled-plugin ownership and prevent silent drift

There are two layers of enforcement:

<AccordionGroup>
  <Accordion title="Runtime registration enforcement">
    The plugin registry validates registrations as plugins load. Examples: duplicate provider ids, duplicate speech provider ids, and malformed registrations produce plugin diagnostics instead of undefined behavior.
  </Accordion>
  <Accordion title="Contract tests">
    Bundled plugins are captured in contract registries during test runs so OpenClaw can assert ownership explicitly. Today this is used for model providers, speech providers, web search providers, and bundled registration ownership.
  </Accordion>
</AccordionGroup>

The practical effect is that OpenClaw knows, up front, which plugin owns which surface. That lets core and channels compose seamlessly because ownership is declared, typed, and testable rather than implicit.

### What belongs in a contract

<Tabs>
  <Tab title="Good contracts">
    - typed
    - small
    - capability-specific
    - owned by core
    - reusable by multiple plugins
    - consumable by channels/features without vendor knowledge

  </Tab>
  <Tab title="Bad contracts">
    - vendor-specific policy hidden in core
    - one-off plugin escape hatches that bypass the registry
    - channel code reaching straight into a vendor implementation
    - ad hoc runtime objects that are not part of `OpenClawPluginApi` or `api.runtime`

  </Tab>
</Tabs>

When in doubt, raise the abstraction level: define the capability first, then let plugins plug into it.

## Skill previews

The Control UI previews a declared plugin skill without installing or executing it.
Opening a preview reads its file inventory and only the entry `SKILL.md` body.
Selecting another file reads that body on demand; navigation never prefetches
sibling contents. The file tree remains available while a selected file loads,
and failed reads can be retried in place.

Catalog reads stay pinned to the selected package version and validate the
inventory’s paths, sizes, and SHA-256 hashes. Installed reads stay inside the
resolved plugin root, reject unsafe links, and reject a changed plugin version.
Both paths retain the file-count, tree-depth, per-file, and aggregate bundle
limits. The aggregate limit applies to the inventory, not selection order.

Loaded bodies and pending reads belong to one open preview and Gateway connection.
Closing, reopening, navigating away, or reconnecting retires that cache. A late
file response can populate its own cache entry but cannot change the selected
file. New selected-file requests revalidate the inventory; only already loaded
bodies are reused. Installed files edited in place become visible on reopening.

## Execution model

Native OpenClaw plugins run **in-process** with the Gateway. They are not sandboxed. A loaded native plugin has the same process-level trust boundary as core code.

<Warning>
Native plugin implications: a plugin can register tools, network handlers, hooks, and services; a plugin bug can crash or destabilize the gateway; and a malicious native plugin is equivalent to arbitrary code execution inside the OpenClaw process.
</Warning>

Compatible bundles are safer by default because OpenClaw currently treats them as metadata/content packs. In current releases, that mostly means bundled skills.

Use allowlists and explicit install/load paths for non-bundled plugins. Treat workspace plugins as development-time code, not production defaults.

For bundled workspace package names, keep the plugin id anchored in the npm name: `@openclaw/<id>` by default, or an approved typed suffix such as `-provider`, `-plugin`, `-speech`, `-sandbox`, or `-media-understanding` when the package intentionally exposes a narrower plugin role.

<Note>
**Trust note:** `plugins.allow` permits **plugin ids** to load; it does not verify source provenance or choose which same-id copy loads. An auto-discovered workspace plugin does not shadow a bundled plugin merely because that id is enabled or allowlisted.

For intentional local overrides, use `plugins.load.paths` to select the plugin path. Tracked global installs can also override ordinary bundled copies. On source installs, plugins built with the host retain priority over tracked globals, including when `OPENCLAW_DEV_SOURCE_ROOT` is unset. Matching package versions alone do not prove that a registry plugin matches a source build's SDK. See [Discovery precedence](/plugins/manifest/package-json#discovery-precedence-duplicate-plugin-ids) for the full order.

A configured path or install record pointing to the host’s own bundled plugin tree retains bundled provenance, including source and compiled entries; a different local copy does not inherit trust from its name or allowlist entry. Checkout runners supply the development selector automatically, including for compiled plugins. See [development debugging](</help/debugging#dev-profile-%2B-dev-gateway-(--dev)>).

Bundled-plugin trust is resolved from the source snapshot — the manifest and code on disk at load time — rather than from install metadata. A corrupted or substituted install record cannot silently widen a bundled plugin's trust surface beyond what the actual source claims.
</Note>

## Export boundary

OpenClaw exports capabilities, not implementation convenience.

Keep capability registration public. Trim non-contract helper exports:

- bundled-plugin-specific helper subpaths
- runtime plumbing subpaths not intended as public API
- vendor-specific convenience helpers
- setup/onboarding helpers that are implementation details

Reserved bundled-plugin helper subpaths have been retired from the generated SDK export map. Keep owner-specific helpers inside the owning plugin package; promote only reusable host behavior to generic SDK contracts such as `plugin-sdk/gateway-runtime`, `plugin-sdk/security-runtime`, and injected plugin API capabilities.

## Internals and reference

For the load pipeline, registry model, provider runtime hooks, Gateway HTTP routes, message tool schemas, channel target resolution, provider catalogs, context engine plugins, and the guide to adding a new capability, see [Plugin architecture internals](/plugins/architecture-internals).

## Related

- [Building plugins](/plugins/building-plugins)
- [Plugin manifest](/plugins/manifest)
- [Plugin SDK setup](/plugins/sdk-setup)
- [Context engines](/concepts/context-engine)
- [Plugin Runtime](/plugins/sdk-runtime) - the `api.runtime` helpers plugins call
