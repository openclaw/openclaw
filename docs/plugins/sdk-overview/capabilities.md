---
summary: "Provider, storage, worker, and embedding registration on OpenClawPluginApi"
title: "Plugin SDK capability registration"
sidebarTitle: "Capability registration"
read_when:
  - You are registering an inference, media, search, or transcript provider
  - You are implementing the cloud-worker provider lifecycle
  - You are registering an embedding provider
  - You are implementing a storage location transport
---

The capability registrars on `OpenClawPluginApi`, and the runtime contracts a
worker, storage, or embedding provider must satisfy. Part of the
[Plugin SDK overview](/plugins/sdk-overview).

## Capability registration

| Method                                           | What it registers                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `api.registerProvider(...)`                      | Text inference (LLM)                                                              |
| `api.registerWorkerProvider(...)`                | Cloud-worker lifecycle leases                                                     |
| `api.registerStorageProvider(...)`               | Opaque object storage for named locations                                         |
| `api.registerModelCatalogProvider(...)`          | Model catalog rows for text and media generation                                  |
| `api.registerAgentHarness(...)`                  | [Experimental](/plugins/sdk-agent-harness) native agent executor (Codex, Copilot) |
| `api.registerCliBackend(...)`                    | Local CLI inference backend                                                       |
| `api.registerChannel(...)`                       | Messaging channel                                                                 |
| `api.registerEmbeddingProvider(...)`             | Reusable vector embedding provider                                                |
| `api.registerSpeechProvider(...)`                | Text-to-speech / STT synthesis                                                    |
| `api.registerRealtimeTranscriptionProvider(...)` | Streaming realtime transcription                                                  |
| `api.registerRealtimeVoiceProvider(...)`         | Duplex realtime voice sessions                                                    |
| `api.registerMediaUnderstandingProvider(...)`    | Image/audio/video analysis                                                        |
| `api.registerTranscriptSourceProvider(...)`      | Live or imported meeting transcript source                                        |
| `api.registerImageGenerationProvider(...)`       | Image generation                                                                  |
| `api.registerMusicGenerationProvider(...)`       | Music generation                                                                  |
| `api.registerVideoGenerationProvider(...)`       | Video generation                                                                  |
| `api.registerWebFetchProvider(...)`              | Web fetch / scrape provider                                                       |
| `api.registerWebSearchProvider(...)`             | Web search                                                                        |
| `api.registerCompactionProvider(...)`            | Pluggable transcript-compaction backend                                           |

Transcript source providers that share an account namespace with an inbound
channel declare an `accountOwnership` descriptor with that channel id and a
shared account resolver. OpenClaw then
ignores model-selected account ids for same-channel capture, binds the trusted
inbound account, and records it as the session owner for later lifecycle
actions. The resolver also selects an omitted account before OpenClaw starts or
persists live capture. It validates an already-bound trusted account without
redirecting it and returns an actionable typed error when no unique capable
account exists. Configured auto-start must supply a nonempty source account or
resolve one with this descriptor. OpenClaw rejects ambiguous or unresolved ownership before it
persists the start or invokes the provider. Provider aliases are lookup names
only and must not be used for this declaration.

### Storage providers

Import `StorageProvider`, `StorageProviderOpenParams`, `StorageBackend`, and
`StorageObjectInfo` from `openclaw/plugin-sdk/plugin-entry`. Register a transport
with `api.registerStorageProvider(provider)` and declare its `id` in
`contracts.storageProviders`. Undeclared IDs, duplicate IDs, and the core-owned
`filesystem` ID are rejected. A configured `storage.locations.<name>.provider`
automatically enables its bundled owner, subject to explicit plugin disablement
and deny rules. External plugins still require explicit enablement.

A provider has an `id`, a `label`, optional synchronous `validateSettings(settings)`
returning a user-facing error, optional `describeTarget(settings)`, and asynchronous
`open(params)`. `describeTarget` returns a non-secret display target or `undefined`.
It must be pure and synchronous: derive the target from settings without I/O or
secret resolution. Configuration listings call it only for the built-in provider
or a provider already present in the supplied registry; they never activate a
plugin or open a backend to describe a target. Otherwise, `displayTarget` is omitted.

Core passes `open` the
location name, read-only settings, optional abort signal, and `resolveSecret(ref)`.
Resolve credentials through that callback; secret-bearing settings must contain
SecretRefs. Return a backend with a non-secret `displayTarget` and these methods:

| Method                                        | Contract                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `probe({ signal }?)`                          | Return optional `freeBytes` and `totalBytes`.                                                             |
| `putObject(key, body, { sizeBytes, signal })` | Consume an `AsyncIterable<Uint8Array>` and return the stored byte count. Never overwrite an existing key. |
| `getObject(key, { signal }?)`                 | Return a byte stream, or `undefined` for an absent object.                                                |
| `statObject(key, { signal }?)`                | Return `{ key, sizeBytes, modifiedAt? }`, or `undefined`. Timestamps use milliseconds.                    |
| `listObjects(prefix, { signal }?)`            | Stream object metadata beneath the prefix.                                                                |
| `deleteObject(key, { signal }?)`              | Delete the object.                                                                                        |
| `close()`                                     | Optional asynchronous resource cleanup.                                                                   |

`sizeBytes`, when provided, is exact. Use atomic conditional creation when the
backend supports it; otherwise check for an existing object first and document
the race. Honor abort signals throughout streaming and keep memory bounded.
Core validates keys before calling the transport: slash-separated segments of
ASCII letters, digits, `.`, `_`, and `-`, excluding `.` and `..`, with no empty
segments, leading slash, or backslash, and a maximum of 512 bytes.

Providers store opaque bytes. Core owns location initialization, marker identity,
namespacing, encryption, and health classification; consumers own retention.
Providers must not create or interpret location markers or expose credentials in
`displayTarget` or errors. See [Storage locations](/concepts/storage-locations).

### Worker providers

`destroy({ leaseId, profile, signal?, onCleanupAccepted? })` must resolve only after physical teardown is proven. A provider can set `supportsCleanupAcceptance: true` and call the optional `onCleanupAccepted()` notification once cleanup is accepted and no longer needs the session, or once a provider-owned teardown capture is claimed. The Gateway shuts down session work before supplying this callback, then may complete reclaim while the environment remains `destroying`. The existing lifecycle owner retains the destroy operation, its deadline, and restart recovery. Later rejection records a visible, retryable cleanup failure; it must not be swallowed. The callback is only a notification for this invocation, not authorization for later work. Providers without the capability keep their existing blocking teardown path. Direct environment destruction still waits for confirmation.

The optional teardown `signal` aborts at the provider deadline and when reconciliation is interrupted by shutdown or suspension. Forward it through capture, stop, and post-stop cleanup; wait for owned commands to settle before rejecting. Rejection retains the recorded lease and cleanup intent for startup retry. A provider that cannot cancel remains owned until its actual operation settles; timeout alone never proves release.

The bundled Crabbox provider requests `stop --wait=false`, notifies acceptance, and then uses a waiting `stop` within the same bounded cleanup budget to confirm release. Direct backends that reject asynchronous stop retain blocking cleanup. Terminal or unrecognized inspection results alone do not prove that all provider resources have been released.

Worker providers must also declare their id in `contracts.workerProviders`.

The optional synchronous `resolveDisplayId(profile)` hook supplies a nonsecret backend display ID for picker presentation. Return 1–64 lowercase ASCII letters, digits, or hyphens, starting with a letter (for example, `aws`). Derive it from locally validated settings; do not run commands, read credentials, or make network calls for branding. The existing profile catalog caches this cosmetic fact with its provider/settings snapshot. Missing, invalid, or throwing metadata is omitted without hiding the profile or its machine choices. `environments.list` projects it as optional `providerDisplayId`, never settings. The routing `providerId`, profile ID, permissions, and allocation behavior remain unchanged. Crabbox uses its validated backend provider, so a profile named `production` can display AWS without guessing from its name.
Providers may implement `maintain({ profiles, signal, assertCurrent })` for bounded cleanup that must continue with no active leases. The Gateway invokes it for enabled, configured providers from its existing periodic worker sweep, separately from allocation and reconciliation waits. `profiles` contains cloned settings for the provider's current configured profiles. Call `assertCurrent()` immediately before external effects and after awaited work before durable mutations; authority ends when the invocation settles, its configuration or registration changes, or the Gateway stops. Honor `signal` and settle only after owned commands stop. A provider's plugin service must also cancel and drain maintenance during generation replacement. The hook must not allocate running capacity or treat maintenance as user demand; retention and cleanup policy remain provider-owned.

Core persists durable intent before `provision(profile, operationId, options?)`. Providers validate settings and any optional `options.machineClass`, `options.os`, and `options.executionMode` before external allocation and throw `WorkerProviderError` for permanent profile rejection. `provision` must adopt the same lease for the same operation id and selected execution mode; a retry cannot silently change modes. If provider-owned setup fails after allocation and cleanup is indeterminate, throw `WorkerProviderError.cleanupIndeterminate(leaseId, provisionError, cleanupError)` so core persists the known lease and reconciles teardown instead of replaying provision. If the provider confirms cleanup completed, throw `WorkerProviderError.cleanupComplete(leaseId, provisionError)`. Core finishes local teardown, including node enrollment retirement, and reports the original error as `provider_failure`. The provisioning intent becomes terminal. Report confirmed cleanup only after the operation’s allocation release or authoritative absence is proven and its lease-cleanup commands have settled. Separately retained checkpoint, image-retirement, and capture-recovery obligations remain provider-owned; this signal does not clear them. Ordinary errors preserve uncertain allocations for replay with the same operation ID. Providers may expose process-stable picker metadata with asynchronous `listMachineOptions(profile)`; omit the hook when the profile has no meaningful machine choice. Machine options contain `id`, `label`, optional `os`, optional positive-integer `cpu` and `memoryGb`, and optional `default`. An option without `os` applies to every advertised operating system. The optional asynchronous `listOperatingSystems(profile)` hook returns provider-owned `{ id, label, default?, disabledReason? }` choices. An optional `disabledReason` keeps an unavailable target visible but unselectable and supplies a repair hint (1–256 characters, without surrounding whitespace). Providers still validate target availability before allocation; picker metadata does not authorize provisioning. Plugin authors can derive the item type from `Awaited<ReturnType<NonNullable<WorkerProvider["listOperatingSystems"]>>>[number]` or declare a local structural type; there is no public `WorkerOperatingSystem` export. Core treats OS ids as opaque strings; plugins own their meaning and validation. `environments.list` exposes up to 64 machine options and up to eight operating systems per profile, omitting the operating-system list when there is only one choice. Session-placement providers declare one or both current `supportedExecutionModes` values in this fixed order: `["worker-turn"]`, `["remote-exec"]`, or `["worker-turn", "remote-exec"]`. Empty lists, duplicate values, unknown modes, and unrecognized orders are rejected. `worker-turn` requires a node lease; `remote-exec` accepts either a node lease or an existing SSH lease. Omission advertises no placement modes while preserving direct environment lifecycle calls. Direct environment creation without a session supplies no execution mode, so providers retain their intentional default setup; the bundled Crabbox provider defaults to `worker-turn`. Providers whose provisioning can legitimately exceed core's five-minute default may return a positive millisecond budget from `resolveProvisionTimeoutMs(profile, options?)`; include acquisition, provider-owned setup, and cleanup in that bound. `resolveDestroyTimeoutMs(profile)` declares the equivalent budget for teardown, including snapshot capture or other provider-owned work before confirmed release. Core uses that budget for both requested teardown and bootstrap-failure cleanup; an explicit service timeout override takes precedence. Budgets must be positive safe integers within the platform timer limit.
Core supplies the optional `options.profileId` to both `provision` and `prepareProvision` from the persisted environment record. It identifies the configured profile for display, including replay after that profile changes or is removed; it does not change allocation identity or replace the frozen settings snapshot.

An optional `options.signal` tells the provider to stop the current provisioning attempt. It can abort because the caller cancelled or because the Gateway is shutting down. Forward it to acquisition, project preparation, setup, readiness, and enrollment waits, and settle active commands before rejecting; a caller-visible timeout or abort is not proof that a provider child exited or a lease was released. Compose it with project, runtime-preparation, and enrollment signals instead of replacing it with a narrower grant's signal. Keep cleanup on its independent, uncancelled lifecycle authority. Providers that cannot stop promptly remain owned until their real operation settles.

An aborted signal alone does not request machine destruction: providers must preserve allocations for replay with the same operation ID. For a cancelled attempt, core records destruction intent only for an explicit cancellation or destroy request, then resolves the exact operation's allocation before normal teardown. Gateway shutdown preserves the operation ID and recorded lease for restart adoption without recording destruction intent. Runtime-preparation or enrollment closure likewise stops that work without authorizing allocation destruction.

Providers can implement `prepareProvision(profile, operationId, options?)`, returning an allocation function `() => Promise<WorkerLease>`. Preparation may validate local settings and read configuration, but must not allocate, renew, modify resources, enroll nodes, or call project preparation. Core keeps a fresh environment in `requested` during preparation and records `provisioning` immediately before invoking the returned function. Prepared facts remain in that invocation; do not reread configuration inside the allocation function. A fresh preparation failure needs no provider teardown. A replay preparation failure remains uncertain because a previous invocation may already have allocated. Cancellation or timeout discards the prepared function. Providers without this hook retain the existing `provision` contract; providers implementing it should delegate their direct `provision` entry point to the same preparation and allocation flow.

For provider-owned SSH identity resolution, core supplies the optional `request.assertCurrent` callback. It checks the current lease and local identity invocation; initializing SSH callers also bind it to their preparation lifetime. Core rejects late identity results and closes retained callbacks after resolution or a caller-visible timeout. Legacy resolvers remain supported without a capability declaration; they may call the callback before further effects after an await, but core cannot prevent internal effects in a resolver that ignores it. This does not change provisioning, renewal, or cleanup authority.

Every worker provider must implement `resolveAllocation(profile, operationId)`, returning `{ leaseId: string; sharedHost: boolean }` for the exact operation. Core passes the frozen settings snapshot, even after the named profile changes or is removed. The handle identifies the cleanup target; it does not prove a machine was created or a transport is ready. Resolution must not allocate, start, renew, run setup, read setup secrets, enroll nodes, or wait for availability. Throw if the identity cannot be resolved safely. When destruction is requested before a provision result is recorded, core persists this handle with the existing teardown state and calls `destroy`, without replaying `provision`. `destroy` still must prove release or authoritative absence. Both calls remain serialized behind any earlier provider operation until it actually settles, including after a caller-visible timeout.

For node providers, core supplies optional `options.nodeBootstrapTimeoutMs` to both `resolveProvisionTimeoutMs` and provisioning. This is the core-owned maximum per runtime-preparation/enrollment phase, including the connection wait after bootstrap; reserve it once for each phase the provider may run. Grants arrive after allocation, so their sizes cannot determine the initial outer deadline. Each runtime or enrollment grant supplies optional `bootstrapTimeoutMs`, the command window derived from its actual artifacts (combined bytes when downloading both archives). Use that window for the command within the reserved outer budget, keeping diagnostics and cleanup separate. These optional facts preserve existing provider source compatibility; they carry timing policy, not authority, expiry, or permission to retry.

Providers that enroll cloud nodes set `requiresNodeEnrollment: true` and call `options.beginNodeEnrollment()` after allocating the machine. The returned `WorkerNodeEnrollment` supplies `displayName`, `openclawVersion`, an optional enrollment-lifetime `signal`, `waitForDeviceId()`, and either `mode: "connect"` with `setupCode` and `setupId`, or `mode: "resume"` with the bound `deviceId`. Its required `nodeBootstrap` contains the Gateway-prepared runtime archive's `url`, secret bearer `token`, `sha256`, `bytes`, `openclawVersion`, `enabledPluginIds`, and optional `tlsFingerprint`. Download that exact archive, verify its size and digest, install its target-platform dependencies, and enable the listed plugins in the node's isolated state before connecting. Do not substitute a global or registry package based only on a matching version. Keep download and enrollment credentials out of command arguments, logs, npm, and the launched node's environment; cancel work when `signal` aborts. Download authority belongs to the live enrollment attempt, not the URL or digest alone. After connection, return the device identity from `waitForDeviceId()` in the node lease. See [Bundle installation](/gateway/cloud-workers#bundle-installation) for source builds, artifact reuse, and proxy requirements. Bootstrap installation does not authorize node commands or replace invocation policy.

Providers that capture reusable project images can declare `supportsProjectPreparation(profile, machineClass?, os?)`. The optional placement overrides are strings; the machine-class argument retains its existing position so older providers remain compatible. Use those overrides when deciding whether preparation is supported. For eligible Git placements, core persists a project identity and pinned base commit before allocation, then supplies `options.project`. Call its `prepare({ runScript, upload })` adapter on the allocated machine; core owns the bounded Git transfer, clean checkout verification, and cache layout, while the provider owns command and file transport. Honor `project.signal` and call `project.assertCurrent()` around awaited provider work. Retained callbacks reject after the provision attempt closes. Project keys are scoped to the Gateway and repository, including linked worktrees. Repository-only sources also bind the repository instance and current shared read identity; core revalidates visibility and access. Public sources fetch without worker credentials. Private sources use a Gateway-owned authenticated temporary object store and transfer only a verified Git pack through the same adapter; provider scripts and uploads never receive the GitHub credential. Public and private sources have separate project keys without changing their persisted source fields. Providers without project preparation retain ordinary checkout after enrollment. Session edits and Git credentials are excluded from the prepared base.

The optional `project.label` is display metadata and does not affect the project key. Local snapshots preserve the normalized `host/owner/repo` from their `origin` remote, or the project root basename when no repository label can be resolved; this label is preserved on replay. Repository projects derive the same normalized label from their admitted normalized URL when core passes the project to the provider.

Providers that can retain completed setup on dedicated nodes also implement `resolvePreparationTarget(profile, machineClass?, os?)`, returning the effective machine class and platform, plus architecture when known. Providers can also return `profileKey`, a SHA-256 digest of their resolved disk and boot settings, excluding runtime artifacts and lease policy. Core uses that fingerprint for snapshot compatibility; providers that omit it retain conservative settings-based compatibility. Core combines the target facts with the project identity, setup recipe, workspace protocol, and preparation contract version. The separate ready-worker key also binds the exact commit, profile, and current runtime artifacts before allocation. When `options.project.preparation` is present, call `prepare` with `runScriptWithBudget(createScript, signal)` as well as the existing transport methods; pass the command's remaining millisecond budget to the renderer before running repository code. Honor a returned `captureRequired: true` even when an older image has the same commit and runtime, while preserving the selected image generation's capture authority. The node lease returned by `provision` must include `sharedHost: false` to attest dedicated ownership; `true` or an omitted field is rejected before prepared-workspace registration. Core preserves the supplied boolean through lease validation. Core registers the returned workspace and manifest identities after enrollment, then binds them once to the exact session. On an already enrolled provision retry, call `project.inspectPreparedWorkspace({ runScript })` to recover the existing completion facts without transferring, executing setup, or capturing. Missing or changed completion fails visibly; it cannot become a new pristine baseline.

Core supplies `options.nodeRuntimeIdentity` as a grant-free prepared fact: the node archive SHA-256, execution mode, and worker archive SHA-256 when project preparation retains that archive. Compare this identity when deciding whether captured runtime content is current; a version string is insufficient. Core checks the later runtime and enrollment descriptors against these prepared bytes and closes their grants if the identity changes.

Providers participating in prepared-project ready capacity implement
`resolvePreparedIdleTimeoutMs(profile)`, returning a positive safe millisecond
duration from their existing idle policy, or `undefined` when reserves are
unsupported. `options.project.preparation` also carries `purpose` (`"session"`
or `"reserve"`) and the originating `demandAtMs`; repeated allocation must
preserve both. Reserve preparation and refill do not create fresh demand. After
successful activation, core can call
`notePreparedDemand({ leaseId, profile }, { preparationKey, demandAtMs })`.
Update only the exact image generation selected or produced by that lease;
timestamps and matching digests do not authorize changing another generation.
This hook records metadata only; it must not allocate, capture, or renew a worker.
Successful foreground demand is still recorded when ready capacity is disabled.
Allocation and fork timestamps do not establish successful foreground demand.
Keep a newly captured foreground image's demand unset until activation, while
retaining its producer's actual generation receipt until confirmed source stop.

Before ordinary enrollment or project capture, call `options.prepareNodeRuntime()` to obtain artifact access without creating a node identity or enrollment code. The result includes `nodeBootstrap`, `workerBundle`, and the operation's cancellation `signal`. The worker archive descriptor supplies `url`, secret `token`, `sha256`, `bytes`, optional `tlsFingerprint`, and the core-owned `packageRelativePath` within the installed node package. Download and verify both archives, install the runtime, and publish the compressed worker archive at that exact contained location before enrollment or capture. The bundled Crabbox provider uses this same preparation step for project-less enrollment, overlapping the worker archive download with runtime installation. Keep one published worker archive per runtime package, exclude credentials and receipts, and never add the standalone payload to the slim runtime archive. The normal authenticated installer validates the prepared bytes and creates a fresh installation after enrollment; the raw archive grants no admission authority. Finish capture before calling `beginNodeEnrollment()`. Beginning enrollment, cancellation, replacement, or closure revokes both preparation grants. A native capture with an uncertain outcome must settle or be explicitly recovered before enrollment can introduce credentials into its source machine. Persist the original cold/checkpoint allocation decision before contacting the provider, retain checkpoint references until confirmed release, and never switch images when replaying the same operation.

Core persists the validated profile settings with the lease and supplies that snapshot to `destroy({ leaseId, profile })`, which must be safe to repeat, and `inspect({ leaseId, profile })`, which returns `active`, `dormant`, `destroyed`, or `unknown`. This lets providers route lifecycle calls after a gateway restart or named-profile removal. SSH endpoints use a `SecretRef` for `keyRef`, never inline key material, and include a `hostKey` from trusted provisioning output as exactly `algorithm base64`, without a hostname or comment. Core pins `hostKey` and never trusts a key from the first connection. Providers may also return up to 10 ordered, unique `fallbackPorts` (integer ports from 1 through 65535, excluding the primary `port`); core validates and persists those advertised candidates for checks safe to repeat, content-addressed transfers, receipt/lock-guarded artifact installation, convergent managed-worktree mirroring, and tunnel reconnects. Ambiguous unguarded stateful commands are rejected and are not replayed across candidates. A lease may set `sharedHost: true` when the SSH account also owns unrelated processes; core then avoids host-wide process freezing during workspace reconciliation. For ordinary leases, omission retains the legacy dedicated-host behavior; prepared-workspace registration requires an explicit `sharedHost: false` in the provision result. Active inspection repeats this fact so core can reconcile provider-owned isolation for leases persisted before the field existed; tunnel startup waits for that first authoritative inspection. A provider that mints a dynamic `keyRef` can implement `resolveSshIdentity({ leaseId, profile, keyRef })`; when present, that resolver is authoritative, while providers without it use the configured generic secret resolver.
`WorkerLease.desktop` is optional and has the shape `{ protocol: "rfb"; port: number; passwordFilePath?: string; username?: string; allowsResize?: boolean; apps?: WorkerDesktopApp[] }`; `passwordFilePath`, when present, must be an absolute path on the worker (POSIX or Windows). Setting `allowsResize: false` restricts a native desktop from provider-wide virtual-display resizing. Providers report this warm-time capability from `provision`; it cannot be retrofitted onto a live lease. The owning SSH or node carrier reads the password on the worker when needed and never persists it in the Gateway store. `WorkerDesktopApp` is a closed union: `{ id: "browser"; executablePath: string; args?: string[]; cdpPort: number }` or `{ id: "terminal"; executablePath: string; args?: string[] }`. App ids must be unique, executable paths must be absolute, browser CDP ports must be integers from 1 through 65535, and the list accepts at most eight entries. Core rejects unknown ids and fields. Optional `args` are fixed by the provider and travel with its admitted launcher, never supplied by the viewer. They run without a shell on the node; each argument is NUL-free and bounded to 4 KiB, with at most 32 arguments and 8 KiB total. Gateway validation accepts POSIX and Windows absolute paths independently of the Gateway OS; the node validates its native path syntax. An optional `username` identifies the lease-owned ARD account, with its password read from `passwordFilePath` and kept transient between the node and Gateway. Managed ARD account authentication requires the node carrier; credentials never enter the browser. Ordinary host desktops retain their existing viewer-supplied ARD credentials.
Providers with renewable leases can also implement `renew(leaseId)`.
`inspect` must throw on transient or indeterminate failures; return `unknown` only for authoritative absence. Core can pass an optional `signal` in `inspect({ leaseId, profile, signal })` to cancel an observation during shutdown. Forward it to inspection commands and settle owned commands before rejecting; cancellation does not prove lease absence or authorize teardown. Core fences an authoritatively absent environment and invokes the normal teardown; shared or unknown host isolation still requires acknowledgment that the exact worker stopped. A shared host must not be stopped or unpaired merely to release its logical lease.

Embedding providers registered with `api.registerEmbeddingProvider(...)` must
also be listed in `contracts.embeddingProviders` in the plugin manifest. This
is the generic embedding surface for reusable vector generation. Memory search
consumes this generic provider surface. The older memory-specific registrar and
manifest contract were removed after their August 2026 migration window.

Bundled embedding providers can receive an optional host-injected
`acquireLocalService` hook matching the existing public
`PluginRuntime["llm"]["acquireLocalService"]` shape. It leases only the configured
local service. Forward the caller's signal, observe readiness through the optional
target callback `onReadinessWait`, and release the lease after the provider request
settles.

Embedding providers can type their asynchronous `batchEmbed(...)` capability with
`EmbeddingProviderBatchRuntime` from
`openclaw/plugin-sdk/embedding-provider-runtime-contract`. The public contract
contains batch chunks and execution options, without host cache or identity metadata.
Batches remain per-file unless the runtime sets `sourceWideBatchEmbed: true`.
That opt-in lets the memory host submit chunks from
multiple dirty memory files and enabled sources in one `batchEmbed(...)` call up
to the host batch limits. Batch adapters that upload JSONL request files must
split provider jobs before their upload-size cap as well as their request-count
cap. The provider must return one embedding per input chunk in the same order as
`batch.chunks`; omit the flag when the provider expects file-local batches or
cannot preserve input ordering across a larger source-wide job.

## Versioned decision data

The focused `openclaw/plugin-sdk/decisions` entrypoint provides additive V2 data
types and pure validation/conversion helpers for adapters and saved decision fixtures.
These helpers do not run a provider, collect evidence, choose a model, or issue host
authority. The existing V1 `api.runtime.decisions.evaluate` contract remains
available. V2 execution uses `api.runtime.decisions.evaluateV2` and a versioned
provider registration; importing data types alone does not authorize execution.

`DecisionContentV2` distinguishes text, JSON, image data, and stable-ID lists.
Answers preserve explicit Boolean decisions separately from P(true), nullable
choices, fractional scores, sort/tag results, per-question errors, and reported
usage. Missing estimates and costs stay missing. Independent estimates are not
normalized; categorical distributions retain their declared constraints. Data
and validation results are never permission to execute an action.

`validateDecisionBatchV2` and `validateDecisionResultV2` enforce the bounded data
contract. Result validation optionally accepts the route's declared decision
capabilities. Structural validation alone cannot prove that a provider supports
an operation, an input modality, or a reasoning mode.

The four explicit codecs are `decisionBatchV1ToV2`,
`decisionBatchV2ToV1`, `decisionResultV1ToV2`, and
`decisionResultV2ToV1`. Unsupported or unrepresentable data returns
`undefined` instead of being coerced. Malformed batch input throws
`DecisionContractError`. They preserve values rather than performing inference,
thresholding, argmax, probability normalization, or accounting estimates.

System One adapters can share `encodeSystemOneQuestions` and
`decodeSystemOneResponse` from the same entrypoint. Encoding renames Boolean
questions to native `noul`; the caller still owns input and question admission.
The strict decoder preserves native labels, scores, distributions, model identity,
and usage, requiring token counts and bounded confidence for Choice/Score/Box.
It returns an untrusted candidate, not an admitted result: always call
`validateDecisionResultV2(batch, candidate, capabilities)` before returning it.
These helpers perform no HTTP, auth, retries, or accounting.

For example, an explicit V2 JSON string cannot become V1 text without losing its
evidence kind. Rich answers, abstention, or accounting that V1 cannot represent
also cannot be silently downgraded. Compatible conversions may share readonly
input data; they do not promise an independent deep copy.

## Prepared decision execution (contract version 2)

Register `DecisionProviderV2` with `contractVersion: 2` and the provider ID declared
in `contracts.decisionProviders`. Supply its normal provider definition in the
registration's `provider` field, or register that provider first from the same
plugin. A different plugin cannot attach an executor to that provider ID.

Declare decision capabilities under `modelCatalog.providers.<id>.models[].inference`.
Set `chat: false` for typed-only models. They appear in the decision catalog and
stay out of conversational model pickers; no chat context window or token cost
needs to be invented. The documented V1 `decisionModels` manifest input is
normalized into this catalog. An explicit canonical row owns its whole contract.

Consumers call `api.runtime.decisions.evaluateV2(batch, options)` with the same
purpose, rubric version, deadline, signal and explicit decision-model selection
as V1. Optional `reasoning` must match the selected model's declared modes.
The prepared runtime resolves that exact model, normal provider credentials and
route. An explicit `@profile` selection is locked; it cannot fall through to
another account. Credentials resolve for the selected agent/profile during preparation;
provider status makes no global V2 credential-readiness claim.
V2 providers receive private prepared model/auth facts and a
required `isAdmissible()` predicate. Check it immediately before physical I/O,
including after DNS or a worker queue wait. False closes the request; do not
swallow an authority assertion to continue inference.

The host retains the request until physical provider cleanup settles, even when
cancellation or plugin reload has already revoked dispatch authority. It validates
and snapshots accepted output before returning it. Auth facts, headers and
transport overrides do not enter public results. Cost recording is a separate
consumer of accepted outcomes. V1 and V2 SDK calls, core calls, the explicit tool,
and the tool prefilter record validated usage once after their final caller
checks pass. Rejected, retired or cancelled results produce no usage event.
Accounting uses the selected provider/model without auth profile suffixes and
the explicit operation agent. Only plugin calls carry a calling-plugin identity.
Reported USD costs, including zero, win over prepared token rates. Unknown route pricing stays
unknown. Estimates enter accounting only; returned usage keeps provider facts.
Missing usage and native-unit-only usage do not emit token/cost events.

The core `decision_evaluate` tool also uses V2 execution. Omit `contractVersion`
for the existing Boolean/Choice/Score input shape, or set `contractVersion: 2` for
tagged text, JSON, image or list state and the provider's declared native question
types. Box questions require image state and return normalized `top`, `bottom`,
`left`, and `right` edges; use a separate Boolean question to check presence.
The tool exposes accepted native answers, abstention,
per-question errors, metadata and usage without V1 result narrowing. Existing V1
providers continue through the lossless input/result bridge. Automatic consumers
that still use V1 retain their own fallback behavior when a native result cannot
be represented without loss.

V1 and V2 callers can use either provider version when the pure SDK codecs can
represent the entire batch and result without loss. Native abstention, images,
sort/tag/box questions or other unrepresentable data return `unsupported-input`
across the V1 boundary. They never become fabricated probabilities or labels.
Existing V1 providers retain their documented execution contract. External
plugins adopt V2 only after a host release exports the required V2 SDK surface.

## Decision models (contract version 1)

Start with [Decision models](/concepts/decision-models) for model choices,
configuration, and Choice/Score/Boolean rubric examples. This section defines
the provider and consumer SDK contract.

`api.registerDecisionProvider({ id, contractVersion: 1, isReady, evaluate })` registers
an optional decision provider, separate from conversational model providers and
agent tools. Declare the ID in manifest `contracts.decisionProviders`; duplicate
IDs are rejected. Registration and optional `isReady()` must be local, synchronous,
and network-free. Import types from `openclaw/plugin-sdk/decisions`.

Consumers call `api.runtime.decisions.evaluate(batch, { agentId?, purpose, priority?, rubricVersion,
timeoutMs, signal })`. State and rubric entries are finite JSON. Use plain objects
and arrays; custom prototypes, serialization hooks, and getters are rejected on
both request and response boundaries. Choices preserve
all offered labels and probabilities; the chosen label is the provider's decision
and need not equal the largest rounded probability. Consumers choose whether to
use that label or an explicit distribution policy. Ordered scores are fractional
estimated zero-based positions, with index-aligned probabilities; Boolean answers
carry `probabilityTrue`. The host validates the entire batch atomically: exact answer
keys, finite probabilities in [0, 1], positive distribution mass, and scores within
the submitted rubric. Reported probabilities may be rounded and need not sum
exactly to one; scores need not equal the expectation of that rounded distribution.
The host preserves those values. Consumers that require normalized weights must
apply their own explicit policy. Provider confidence is a provider-specific metric,
not calibrated correctness. Results include model, optional token usage, and local
rubric and runtime-generation provenance.

Set `agents.defaults.decisionModel` to an explicit `provider/model` reference.
Unset or empty means off. `agents.entries.<id>.decisionModel` overrides the global
default; an empty agent value disables decisions for that agent. There is no
automatic conversational-model fallback. Selection makes the provider available
to supported consumers. Consumers own their feature activation and evidence
selection; provider configuration alone does not schedule background work. Evidence
sent to the selected provider may incur its normal usage charges. Plugin disablement
wins; installing a tool or credential alone does not select a provider. Vendor adapters
own transport and model-specific translation; no vendor is a core dependency.

The [ONNX plugin](/plugins/onnx) supplies local classifiers; the
[TypeSafe AI plugin](/plugins/typesafe) supplies hosted Jev and local System One
adapters, including Kev. Both plugins require
separate installation, explicit setup, and role selection.

### Calling from a third-party plugin

Like `api.runtime.llm.complete`, `api.runtime.decisions.evaluate` lets a plugin
consume a host-configured provider without handling its credentials. The consumer
does not need the provider's SDK, API key, SecretRef, or a provider registration.
Only the provider plugin registers `contracts.decisionProviders` and owns its
vendor transport and prepared credential input. This does not make conversational
model credentials interchangeable with decision-provider credentials.

The operator must enable and configure the provider plugin and select
`agents.defaults.decisionModel` (or an agent override). Third-party plugins own
their feature's activation, evidence selection, and permission to send that
evidence. Having credentials alone must not activate background collection or
spending.

The host applies the registered consumer plugin's `allowedCompletionModels`
policy from `plugins.entries.<consumer-id>.llm` before provider dispatch. An empty
or invalid-only list denies all models; `["*"]` permits any model at this policy
layer. Pass the operation's owning `agentId` as before; omitting it selects the
global decision role, even inside an agent operation. Unlike the agent-bound LLM
runtime, Decision calls select their owner explicitly and do not require
`allowAgentIdOverride`.

A configured decision role is not a caller model override, so `allowModelOverride`
and the override-only `allowedModels` do not gate it. The agent's conversational
`modelPolicy.allow` is not an all-completion restriction. Current Gateway operator
model policy remains independently enforced, including revocation and cancellation.
Request fields cannot substitute consumer identity or another plugin's policy.
Authorization failures throw rather than return an `unavailable` fallback outcome.
The built-in decision tool uses its host-bound agent rather than a public override.

Call from a live plugin tool, hook, or other owned operation, carrying its
cancellation signal:

```ts
const outcome = await api.runtime.decisions.evaluate(
  {
    state: { message: "Can you help me with this?", directlyAddressed: true },
    questions: {
      respond: {
        type: "boolean",
        instructions: "Is this message asking the assistant to respond?",
        criteria: {
          true: "The message asks the assistant to respond",
          false: "The message does not ask the assistant to respond",
        },
      },
    },
  },
  {
    agentId, // The agent that owns this operation; omit only for global-default selection.
    purpose: "example-plugin.response-eligibility",
    rubricVersion: "1",
    timeoutMs: 1500,
    signal,
  },
);
```

An `ok` outcome contains validated answers, model/usage, and provider/rubric/runtime
provenance. It is evidence for the consumer's decision, not permission to send a
message or perform another effect. An `unavailable` outcome carries a reason for
the consumer's existing fallback. Do not catch cancellation or closed-authority
errors and turn them into fallback work.

The provider receives the selected `model` and optional `agentId` in its evaluation
context. Concurrent agent/model selections share provider health without retiring
each other. A changed selection fences the affected request before returning it.

Automatic consumers check the Labs opt-in at provider dispatch. Disabling it
stops future evaluations, not already-dispatched work or use of its result. The
host supplies `context.isAdmissible()` for ongoing consumer authority, model
selection, and provider configuration/credential generation checks; the Labs
toggle is not part of those ongoing checks. Providers performing external I/O
must call it synchronously immediately before sending,
after any lazy loading, DNS, or other awaited preparation. A false result closes
that evaluation; a thrown authority assertion is terminal. The host remembers
either observation across provider cleanup, so revocation cannot become a provider
health failure or a later successful result. Omission preserves explicit
`decision_evaluate` calls and older-host compatibility; it is not a Labs check for
explicit calls. TypeSafe uses its guarded transport’s final `beforeRequest` hook.
The host still checks before provider dispatch and before returning results, but
cannot prevent I/O in third-party providers that ignore this callback. Local ONNX
inference retains its existing signal-controlled worker lifecycle; it does not
transmit evidence to an external service.

Consumers share the selected provider's host-owned concurrency, circuit, and
credential-refresh lifecycle; each plugin does not create its own provider client.
No credential is returned to the consumer. Provider setup and refresh use the
same prepared-secret path whether the caller is built-in or third-party.

The host admits at most four requests, with no queue and a 30-second maximum.
`priority` defaults to `"requested"`. Set `"optional"` for opportunistic assistance:
it returns `overloaded` when three requests are already in flight, leaving the
fourth slot for requested evaluations. Purpose strings do not determine priority.
All requests retain their slots until the provider physically settles, including
after cancellation. Consumers can request shorter deadlines and choose their own fallback policy.
The caller's `timeoutMs` includes runtime preparation. Expired preparation never
starts a provider evaluation; otherwise the provider receives the remaining budget.
The call still waits for physical cleanup, which can outlive the deadline.
Three transport, rate-limit, or invalid-response failures open a ten-second circuit;
recovery admits one trial. Retry-After is bounded to one minute. Authentication
failures return to the caller without opening the shared provider circuit: another
agent or a later evaluation may use a different credential. There are no host retries
or health checks.

Caller cancellation and closed consumer authority reject: do not start fallback.
Provider retirement returns unavailable while a live consumer can fall back.
Providers must honor the composed abort signal and physically settle transport
and body cleanup; an uncooperative provider stays owned and fenced by normal
failed-drain recovery. Old generation outcomes cannot update new health.

Manifest capability credentials use `configContracts.secretInputs` and authored
SecretRefs. `getPreparedPluginSecretInput(pluginId, path)` from
`openclaw/plugin-sdk/secret-input-runtime` reads only a prepared, available snapshot;
it never resolves a cold reference or consults ambient environment credentials.
Call it only from the plugin instance's active invocation. The helper is not a
durable credential capability: quiescing or retiring that exact instance removes
read authority immediately, even while already-admitted work is finishing. A
provider must treat a missing value as unavailable and must not retain or reuse a
previous value across reload. Refresh with `secrets.reload`; capability failure
does not retain an old key.

`plugins.inspect` reports configuration, credential readiness, current callability,
last success, usage, latency, and bounded unavailable counts. For V1, `credentialReady: true`
means the provider's local `isReady()` confirmed prepared credentials. `false`
means readiness is unconfirmed or unavailable, not necessarily that credentials
are missing. V2 omits `credentialReady` because credentials are selected for each
agent/profile during preparation. Omitting V1 `isReady()` leaves evaluation eligible; returning `false`
blocks it. `callable` separately reports current admission for requested evaluations,
not guaranteed success.
Counts are instance-local diagnostics, not durable audit records or write authority.

For discovery, declare decision capabilities in the model's canonical
`modelCatalog.providers.<id>.models[].inference.decision` metadata. Each provider
must be owned by `contracts.decisionProviders`. The Control UI Decision picker
reads a separate `models.list.decisionModels` projection; no provider runtime or
credential check runs to populate the picker. Models with `inference.chat: false`
stay out of conversational pickers. Existing V1 `decisionModels` declarations
normalize into this catalog at manifest loading.

Decision metadata describes supported question types, input limits and their
accounting scope, Boolean criteria requirements, and confidence semantics.
The core `decision_evaluate` tool uses the prepared catalog when available,
otherwise the canonical manifest catalog; provider readiness does not change its
definition. See the
[manifest reference](/plugins/manifest/capabilities#decision-models-reference)
for the bounded descriptor fields.
