---
summary: "Provider, worker-provider, and embedding registration on OpenClawPluginApi"
title: "Plugin SDK capability registration"
sidebarTitle: "Capability registration"
read_when:
  - You are registering an inference, media, search, or transcript provider
  - You are implementing the cloud-worker provider lifecycle
  - You are registering an embedding provider
---

The capability registrars on `OpenClawPluginApi`, and the runtime contracts a
worker or embedding provider must satisfy. Part of the
[Plugin SDK overview](/plugins/sdk-overview).

## Capability registration

| Method                                           | What it registers                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `api.registerProvider(...)`                      | Text inference (LLM)                                                              |
| `api.registerWorkerProvider(...)`                | Cloud-worker lifecycle leases                                                     |
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
canonical account resolver. OpenClaw then
ignores model-selected account ids for same-channel capture, binds the trusted
inbound account, and records it as the session owner for later lifecycle
actions. The resolver also selects an omitted account before OpenClaw starts or
persists live capture. It validates an already-bound trusted account without
redirecting it and returns an actionable typed error when no unique capable
account exists. Configured auto-start must supply a nonempty source account or
resolve one with this descriptor. OpenClaw rejects ambiguous or unresolved ownership before it
persists the start or invokes the provider. Provider aliases are lookup names
only and must not be used for this declaration.

### Worker providers

Worker providers must also declare their id in `contracts.workerProviders`.

The optional synchronous `resolveDisplayId(profile)` hook supplies a nonsecret backend display ID for picker presentation. Return 1–64 lowercase ASCII letters, digits, or hyphens, starting with a letter (for example, `aws`). Derive it from locally validated settings; do not run commands, read credentials, or make network calls for branding. The existing profile catalog caches this cosmetic fact with its provider/settings snapshot. Missing, invalid, or throwing metadata is omitted without hiding the profile or its machine choices. `environments.list` projects it as optional `providerDisplayId`, never settings. The routing `providerId`, profile ID, permissions, and allocation behavior remain unchanged. Crabbox uses its validated backend provider, so a profile named `production` can display AWS without guessing from its name.
Providers may implement `maintain({ profiles, signal, assertCurrent })` for bounded cleanup that must continue with no active leases. The Gateway invokes it for enabled, configured providers from its existing periodic worker sweep, separately from allocation and reconciliation waits. `profiles` contains cloned settings for the provider's current configured profiles. Call `assertCurrent()` immediately before external effects and after awaited work before durable mutations; authority ends when the invocation settles, its configuration or registration changes, or the Gateway stops. Honor `signal` and settle only after owned commands stop. A provider's plugin service must also cancel and drain maintenance during generation replacement. The hook must not allocate running capacity or treat maintenance as user demand; retention and cleanup policy remain provider-owned.

Core persists durable intent before `provision(profile, operationId, options?)`. Providers validate settings and any optional `options.machineClass`, `options.os`, and `options.executionMode` before external allocation and throw `WorkerProviderError` for permanent profile rejection. `provision` must adopt the same lease for the same operation id and selected execution mode; a retry cannot silently change modes. If provider-owned setup fails after allocation and cleanup is indeterminate, throw `WorkerProviderError.cleanupIndeterminate(leaseId, provisionError, cleanupError)` so core persists the known lease and reconciles teardown instead of replaying provision. If the provider confirms cleanup completed, throw `WorkerProviderError.cleanupComplete(leaseId, provisionError)`. Core finishes local teardown, including node enrollment retirement, and reports the original error as `provider_failure`. The provisioning intent becomes terminal. Report confirmed cleanup only after the operation’s allocation release or authoritative absence is proven and its lease-cleanup commands have settled. Separately retained checkpoint, image-retirement, and capture-recovery obligations remain provider-owned; this signal does not clear them. Ordinary errors preserve uncertain allocations for replay with the same operation ID. Providers may expose process-stable picker metadata with asynchronous `listMachineOptions(profile)`; omit the hook when the profile has no meaningful machine choice. Machine options contain `id`, `label`, optional `os`, optional positive-integer `cpu` and `memoryGb`, and optional `default`. An option without `os` applies to every advertised operating system. The optional asynchronous `listOperatingSystems(profile)` hook returns provider-owned `{ id, label, default?, disabledReason? }` choices. An optional `disabledReason` keeps an unavailable target visible but unselectable and supplies a repair hint (1–256 characters, without surrounding whitespace). Providers still validate target availability before allocation; picker metadata does not authorize provisioning. Plugin authors can derive the item type from `Awaited<ReturnType<NonNullable<WorkerProvider["listOperatingSystems"]>>>[number]` or declare a local structural type; there is no public `WorkerOperatingSystem` export. Core treats OS ids as opaque strings; plugins own their meaning and validation. `environments.list` exposes up to 64 machine options and up to eight operating systems per profile, omitting the operating-system list when there is only one choice. Session-placement providers declare one or both current `supportedExecutionModes` values in deterministic canonical order: `["worker-turn"]`, `["remote-exec"]`, or `["worker-turn", "remote-exec"]`. Empty lists, duplicate values, unknown modes, and noncanonical order are rejected. `worker-turn` requires a node lease; `remote-exec` accepts either a node lease or an existing SSH lease. Omission advertises no placement modes while preserving direct environment lifecycle calls. Direct environment creation without a session supplies no execution mode, so providers retain their intentional default setup; the bundled Crabbox provider defaults to `worker-turn`. Providers whose provisioning can legitimately exceed core's five-minute default may return a positive millisecond budget from `resolveProvisionTimeoutMs(profile)`; include acquisition, provider-owned setup, and cleanup in that bound. `resolveDestroyTimeoutMs(profile)` declares the equivalent budget for teardown, including snapshot capture or other provider-owned work before confirmed release. Core uses that budget for both requested teardown and bootstrap-failure cleanup; an explicit service timeout override takes precedence. Budgets must be positive safe integers within the platform timer limit.
Core supplies the optional `options.profileId` to both `provision` and `prepareProvision` from the persisted environment record. It identifies the configured profile for display, including replay after that profile changes or is removed; it does not change allocation identity or replace the frozen settings snapshot.

An optional `options.signal` cancels the current provisioning attempt. Forward it to acquisition, project preparation, setup, readiness, and enrollment waits, and settle active commands before rejecting; a caller-visible timeout or abort is not proof that a provider child exited or a lease was released. Compose it with project, runtime-preparation, and enrollment signals instead of replacing it with a narrower grant's signal. Keep cleanup on its independent, uncancelled lifecycle authority. Core records destroy intent for the exact operation and resolves its allocation before canonical teardown; providers that cannot cancel promptly remain owned until their real operation settles. Gateway shutdown is distinct: enrollment closure alone retains a fixed allocation for restart adoption, while an aborted provisioning signal means explicit cancellation.

Providers can implement `prepareProvision(profile, operationId, options?)`, returning an allocation function `() => Promise<WorkerLease>`. Preparation may validate local settings and read configuration, but must not allocate, renew, modify resources, enroll nodes, or call project preparation. Core keeps a fresh environment in `requested` during preparation and records `provisioning` immediately before invoking the returned function. Prepared facts remain in that invocation; do not reread configuration inside the allocation function. A fresh preparation failure needs no provider teardown. A replay preparation failure remains uncertain because a previous invocation may already have allocated. Cancellation or timeout discards the prepared function. Providers without this hook retain the existing `provision` contract; providers implementing it should delegate their direct `provision` entry point to the same preparation and allocation flow.

Every worker provider must implement `resolveAllocation(profile, operationId)`, returning `{ leaseId: string; sharedHost: boolean }` for the exact operation. Core passes the frozen settings snapshot, even after the named profile changes or is removed. The handle identifies the cleanup target; it does not prove a machine was created or a transport is ready. Resolution must not allocate, start, renew, run setup, read setup secrets, enroll nodes, or wait for availability. Throw if the identity cannot be resolved safely. When destruction is requested before a provision result is recorded, core persists this handle with the existing teardown state and calls `destroy`, without replaying `provision`. `destroy` still must prove release or authoritative absence. Both calls remain serialized behind any earlier provider operation until it actually settles, including after a caller-visible timeout.

Providers that enroll cloud nodes set `requiresNodeEnrollment: true` and call `options.beginNodeEnrollment()` after allocating the machine. The returned `WorkerNodeEnrollment` supplies `displayName`, `openclawVersion`, an optional enrollment-lifetime `signal`, `waitForDeviceId()`, and either `mode: "connect"` with `setupCode` and `setupId`, or `mode: "resume"` with the bound `deviceId`. Its required `nodeBootstrap` contains the Gateway-prepared runtime archive's `url`, secret bearer `token`, `sha256`, `bytes`, `openclawVersion`, `enabledPluginIds`, and optional `tlsFingerprint`. Download that exact archive, verify its size and digest, install its target-platform dependencies, and enable the listed plugins in the node's isolated state before connecting. Do not substitute a global or registry package based only on a matching version. Keep download and enrollment credentials out of command arguments, logs, npm, and the launched node's environment; cancel work when `signal` aborts. Download authority belongs to the live enrollment attempt, not the URL or digest alone. After connection, return the device identity from `waitForDeviceId()` in the node lease. See [Bundle installation](/gateway/cloud-workers#bundle-installation) for source builds, artifact reuse, and proxy requirements. Bootstrap installation does not authorize node commands or replace invocation policy.

Providers that capture reusable project images can declare `supportsProjectPreparation(profile, machineClass?, os?)`. The optional placement overrides are strings; the machine-class argument retains its existing position so older providers remain compatible. Use those overrides when deciding whether preparation is supported. For eligible Git placements, core persists a project identity and pinned base commit before allocation, then supplies `options.project`. Call its `prepare({ runScript, upload })` adapter on the allocated machine; core owns the bounded Git transfer, clean checkout verification, and cache layout, while the provider owns command and file transport. Honor `project.signal` and call `project.assertCurrent()` around awaited provider work. Retained callbacks reject after the provision attempt closes. Project keys are scoped to the Gateway and repository, including linked worktrees. Repository-only sources also bind the repository instance and current shared read identity; core revalidates visibility and access. Public sources fetch without worker credentials. Private sources use a Gateway-owned authenticated temporary object store and transfer only a verified Git pack through the same adapter; provider scripts and uploads never receive the GitHub credential. Public and private sources have separate project keys without changing their persisted source fields. Providers without project preparation retain ordinary checkout after enrollment. Session edits and Git credentials are excluded from the prepared base.

The optional `project.label` is display metadata and does not affect the project key. Local snapshots preserve the normalized `host/owner/repo` from their `origin` remote, or the project root basename when no repository label can be resolved; this label is preserved on replay. Repository projects derive the same normalized label from their admitted canonical URL when core passes the project to the provider.

Providers that can retain completed setup on dedicated nodes also implement `resolvePreparationTarget(profile, machineClass?, os?)`, returning the effective machine class and platform, plus architecture when known. Core fingerprints those target facts, setup recipe, project commit, and current runtime artifacts before allocation. When `options.project.preparation` is present, call `prepare` with `runScriptWithBudget(createScript, signal)` as well as the existing transport methods; pass the command's remaining millisecond budget to the renderer before running repository code. Honor a returned `captureRequired: true` even when an older image has the same commit and runtime, while preserving the selected image generation's capture authority. The node lease returned by `provision` must include `sharedHost: false` to attest dedicated ownership; `true` or an omitted field is rejected before prepared-workspace registration. Core preserves the supplied boolean through lease validation. Core registers the returned workspace and manifest identities after enrollment, then binds them once to the exact session. On an already enrolled provision retry, call `project.inspectPreparedWorkspace({ runScript })` to recover the existing completion facts without transferring, executing setup, or capturing. Missing or changed completion fails visibly; it cannot become a new pristine baseline.

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

Before capturing, call `options.prepareNodeRuntime()` to obtain artifact access without creating a node identity or enrollment code. The result includes `nodeBootstrap`, `workerBundle`, and the operation's cancellation `signal`. The worker archive descriptor supplies `url`, secret `token`, `sha256`, `bytes`, optional `tlsFingerprint`, and the core-owned `packageRelativePath` within the installed node package. Download and verify both archives, install the runtime, and publish the compressed worker archive at that exact contained location before capture. Keep one published worker archive per runtime package, exclude credentials and receipts, and never add the standalone payload to the slim runtime archive. The normal authenticated installer validates the prepared bytes and creates a fresh installation after enrollment; the raw archive grants no admission authority. Finish capture before calling `beginNodeEnrollment()`. Beginning enrollment, cancellation, replacement, or closure revokes both preparation grants. A native capture with an uncertain outcome must settle or be explicitly recovered before enrollment can introduce credentials into its source machine. Persist the original cold/checkpoint allocation decision before contacting the provider, retain checkpoint references until confirmed release, and never switch images when replaying the same operation.

Core persists the validated profile settings with the lease and supplies that snapshot to `destroy({ leaseId, profile })`, which must be idempotent, and `inspect({ leaseId, profile })`, which returns `active`, `dormant`, `destroyed`, or `unknown`. This lets providers route lifecycle calls after a gateway restart or named-profile removal. SSH endpoints use a `SecretRef` for `keyRef`, never inline key material, and include a `hostKey` from trusted provisioning output as exactly `algorithm base64`, without a hostname or comment. Core pins `hostKey` and never trusts a key from the first connection. Providers may also return up to 10 ordered, unique `fallbackPorts` (integer ports from 1 through 65535, excluding the primary `port`); core validates and persists those advertised candidates for idempotent probes, content-addressed transfers, receipt/lock-guarded artifact installation, convergent managed-worktree mirroring, and tunnel reconnects. Ambiguous unguarded stateful commands fail closed and are not replayed across candidates. A lease may set `sharedHost: true` when the SSH account also owns unrelated processes; core then avoids host-wide process freezing during workspace reconciliation. For ordinary leases, omission retains the legacy dedicated-host behavior; prepared-workspace registration requires an explicit `sharedHost: false` in the provision result. Active inspection repeats this fact so core can reconcile provider-owned isolation for leases persisted before the field existed; tunnel startup waits for that first authoritative inspection. A provider that mints a dynamic `keyRef` can implement `resolveSshIdentity({ leaseId, profile, keyRef })`; when present, that resolver is authoritative, while providers without it use the configured generic secret resolver.
`WorkerLease.desktop` is optional and has the shape `{ protocol: "rfb"; port: number; passwordFilePath?: string; username?: string; allowsResize?: boolean; apps?: WorkerDesktopApp[] }`; `passwordFilePath`, when present, must be an absolute path on the worker (POSIX or Windows). Setting `allowsResize: false` restricts a native desktop from provider-wide virtual-display resizing. Providers report this warm-time capability from `provision`; it cannot be retrofitted onto a live lease. The owning SSH or node carrier reads the password on the worker when needed and never persists it in the Gateway store. `WorkerDesktopApp` is a closed union: `{ id: "browser"; executablePath: string; args?: string[]; cdpPort: number }` or `{ id: "terminal"; executablePath: string; args?: string[] }`. App ids must be unique, executable paths must be absolute, browser CDP ports must be integers from 1 through 65535, and the list accepts at most eight entries. Core rejects unknown ids and fields. Optional `args` are fixed by the provider and travel with its admitted launcher, never supplied by the viewer. They run without a shell on the node; each argument is NUL-free and bounded to 4 KiB, with at most 32 arguments and 8 KiB total. Gateway validation accepts POSIX and Windows absolute paths independently of the Gateway OS; the node validates its native path syntax. An optional `username` identifies the lease-owned ARD account, with its password read from `passwordFilePath` and kept transient between the node and Gateway. Managed ARD account authentication requires the node carrier; credentials never enter the browser. Ordinary host desktops retain their existing viewer-supplied ARD credentials.
Providers with renewable leases can also implement `renew(leaseId)`.
`inspect` must throw on transient or indeterminate failures; return `unknown` only for authoritative absence. Core fences the environment and invokes canonical teardown; shared or unknown host isolation still requires acknowledgment that the exact worker stopped. A shared host must not be stopped or unpaired merely to release its logical lease.

Embedding providers registered with `api.registerEmbeddingProvider(...)` must
also be listed in `contracts.embeddingProviders` in the plugin manifest. This
is the generic embedding surface for reusable vector generation. Memory search
consumes this generic provider surface. The older memory-specific registrar and
manifest contract were removed after their August 2026 migration window.

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

## Decision models (contract version 1)

Start with [Decision models](/concepts/decision-models) for model choices,
configuration, and Choice/Score/Boolean rubric examples. This section defines
the provider and consumer SDK contract.

`api.registerDecisionProvider({ id, contractVersion: 1, isReady, evaluate })` registers
an optional decision provider, separate from conversational model providers and
agent tools. Declare the ID in manifest `contracts.decisionProviders`; duplicate
IDs are rejected. Registration and optional `isReady()` must be local, synchronous,
and network-free. Import types from `openclaw/plugin-sdk/decisions`.

Consumers call `api.runtime.decisions.evaluate(batch, { agentId?, purpose, rubricVersion,
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

The host applies the registered consumer plugin's policy from
`plugins.entries.<consumer-id>.llm`. An explicit `agentId`
requires `allowAgentIdOverride: true`; omitting it selects the global decision
role, even inside an agent operation. `allowedCompletionModels` restricts the
configured selected model before provider dispatch. An empty or invalid-only
list denies all models; `["*"]` permits any model at this policy layer.

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
    agentId, // Requires allowAgentIdOverride; omit for global-default selection.
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

Consumers share the selected provider's host-owned concurrency, circuit, and
credential-refresh lifecycle; each plugin does not create its own provider client.
No credential is returned to the consumer. Provider setup and refresh use the
same prepared-secret path whether the caller is built-in or third-party.

The host admits at most four requests, with no queue and a 30-second maximum.
Consumers can request shorter deadlines and choose their own fallback policy.
Three unhealthy responses open a ten-second circuit; recovery admits one trial.
Retry-After is bounded to one minute. Auth errors latch until the prepared-secret
or configuration generation changes. There are no host retries or health probes.

Caller cancellation and closed consumer authority reject: do not start fallback.
Provider retirement returns unavailable while a live consumer can fall back.
Providers must honor the composed abort signal and physically settle transport
and body cleanup; an uncooperative provider stays owned and fenced by normal
failed-drain recovery. Old generation outcomes cannot update new health.

Manifest capability credentials use `configContracts.secretInputs` and authored
SecretRefs. `getPreparedPluginSecretInput(pluginId, path)` from
`openclaw/plugin-sdk/secret-input-runtime` reads only a prepared, available snapshot;
it never resolves a cold reference or consults ambient environment credentials.
Refresh with `secrets.reload`; capability failure does not retain an old key.

`plugins.inspect` reports configuration, credential readiness, current callability,
last success, usage, latency, and bounded unavailable counts. Counts are
instance-local diagnostics, not durable audit records or write authority.

For discovery, declare static `decisionModels` entries in the provider manifest
with `provider`, `id`, and `name`. Each provider must be owned by
`contracts.decisionProviders`. The Control UI Decision picker reads this metadata
through a separate `models.list.decisionModels` projection; no provider runtime
or credential probe runs to populate the picker. These entries never enter the
chat, primary, fallback, or utility model catalogs.

Optional model `capabilities` describe supported question types, input limits and
their accounting scope, Boolean criteria requirements, and confidence semantics.
The core `decision_evaluate` tool uses these same manifest facts for guidance;
provider readiness does not change its definition. See the
[manifest reference](/plugins/manifest/capabilities#decision-models-reference)
for the bounded descriptor fields.
