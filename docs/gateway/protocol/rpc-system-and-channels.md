---
summary: "Gateway RPC families for system status, memory, models, channels, plugins, messaging, and the operator terminal"
read_when:
  - Looking up a system, memory, model, channel, or plugin RPC
  - Wiring operator terminal or messaging methods
  - Checking the scope a gateway method requires
title: "Gateway protocol system and channel methods"
sidebarTitle: "System and channels"
doc-schema-version: 1
---

RPC method families for gateway status and identity, models and usage, channels and login, plugin management, messaging and logs, and the operator terminal.

## System and identity

- `health` returns the cached or freshly checked gateway health snapshot.
- `diagnostics.stability` returns the recent bounded diagnostic stability recorder: event names, counts, byte sizes, memory readings, queue/session state, channel/plugin names, session ids. No chat text, webhook bodies, tool outputs, raw request/response bodies, tokens, cookies, or secrets. Requires `operator.read`.
- `status` returns the `/status`-style gateway summary; sensitive fields only for admin-scoped operator clients.
- `gateway.identity.get` returns the gateway device identity used by relay and pairing flows.
- `system-presence` returns the current presence snapshot for connected operator/node devices.
- `system-event` appends a system event and can update/broadcast presence context.
- `last-heartbeat` returns the latest persisted heartbeat event.
- `set-heartbeats` toggles heartbeat processing on the gateway.
- `gateway.restart.preflight` is a deprecated, read-only compatibility preview of restart-specific active work. It does not close admission, create a suspension lease, or provide the atomic full-work fence of `gateway.suspend.prepare`; new restart flows should call `gateway.restart.request`.
- `gateway.suspend.prepare` creates a short cooperative-suspension lease only when tracked Gateway work is idle. While prepared, authenticated WebSocket connects remain available, but only `gateway.suspend.*` and an exact targeted non-safe `gateway.restart.request` may run; safe and untargeted restarts remain fenced. `gateway.suspend.status` checks the lease, and `gateway.suspend.resume` releases it after thaw or an aborted host operation.

## Models and usage

- `models.list` returns the runtime-allowed model catalog. See [`models.list` views](/gateway/protocol/operator-methods#models-list-views).
- `usage.status` returns provider usage windows/remaining quota summaries. Clients advertising `usage-refreshing` receive an immediate `refreshing: true` placeholder on a cold cache and must refetch on a bounded schedule; other callers block for the cold provider read.
- `usage.cost` returns aggregated cost usage summaries for a date range. Pass `agentId` for one agent, or `agentScope: "all"` to aggregate configured agents.
- `doctor.memory.status` returns provider health for a native memory provider, or vector-memory / cached embedding readiness for a legacy provider. Pass `{ "probe": true }` or `{ "deep": true }` only for an explicit legacy embedding provider ping. Pass `{ "agentId": "agent-id" }` to scope Dreaming store stats to one agent workspace; omitting it aggregates configured Dreaming workspaces.
- `doctor.memory.dreamDiary`, `doctor.memory.backfillDreamDiary`, `doctor.memory.resetDreamDiary`, `doctor.memory.resetGroundedShortTerm`, `doctor.memory.repairDreamingArtifacts`, and `doctor.memory.dedupeDreamDiary` accept optional `{ "agentId": "agent-id" }`; omitted, they operate on the configured default agent workspace.
- `sessions.usage` returns per-session usage summaries. Pass `agentId` for one agent, or `agentScope: "all"` to list configured agents together.
  Both usage methods accept `mode: "specific"` with an IANA `timeZone` for DST-aware calendar-day boundaries and buckets. `utcOffset` remains supported for older clients and as a fallback when the Gateway runtime does not recognize the requested zone.
- `sessions.usage.timeseries` returns timeseries usage for one session.
- `sessions.usage.logs` returns usage log entries for one session.
  Both detail methods accept the selected row's `key` and optional `agentId`. Preserve both fields when opening details for an unqualified key such as `global`.

## Memory

- `memory.search` with `version: 2` searches the selected provider and returns provider-scoped references. Omitting `version`, or sending `version: 1`, uses the legacy file-shaped contract only for legacy providers. A native provider returns an error naming the plugin; retry with `version: 2`.
- `memory.get` resolves a provider-scoped reference through the selected provider.
- `memory.status` reports selected-provider health.

These methods require authenticated operator read authority. `memory.get` and
`memory.status` use the provider-runtime contract directly; `memory.search`
selects that contract when `version: 2` is present.

## Channels and login helpers

- `channels.status` returns built-in + bundled channel/plugin status summaries.
- `channels.start` (`operator.admin`) starts one channel account runtime without re-authenticating. Params `{ channel, accountId? }`; omitted `accountId` selects the default account. Responds `{ channel, accountId, started, outcome }`, with `started` true only when the resulting runtime snapshot reports `running: true`. `outcome` carries the account lifecycle decision: `{ status: "handed-off" }`, `{ status: "retry", reason }`, or `{ status: "skipped", reason }`. The RPC is a manual override of automatic-start suppression; no `manual` parameter is accepted. This is not a provider-connectivity check; see [Per-account recovery](/cli/channels#per-account-recovery-non-destructive) for reasons and recovery guidance.
- `channels.stop` (`operator.admin`) stops one channel account runtime without clearing auth state. Params `{ channel, accountId? }`; omitted `accountId` selects the default account. Responds `{ channel, accountId, stopped }`, with `stopped` true when the resulting runtime snapshot does not report `running: true`. Unlike `channels.logout`, it retains the account's credentials.
- `channels.logout` logs out a specific channel/account where the channel supports it.
- `web.login.start` starts a QR/web login flow. Params include optional `{ channel, accountId, force, timeoutMs, verbose }`. When `channel` is present, the Gateway normalizes its canonical id or alias and dispatches only to that installed channel plugin. Omitting `channel` preserves the legacy behavior of selecting the first loaded QR-capable provider. A provider may return an opaque `sessionKey` with its QR response.
- `web.login.wait` waits for that flow to complete and starts the channel on success. Params include optional `{ channel, accountId, sessionKey, timeoutMs, currentQrDataUrl }`. Use the same `channel` as `web.login.start` and pass its returned `sessionKey` through unchanged so the provider can correlate the wait request with the QR session. Omitting `channel` retains the same legacy provider fallback as `web.login.start`.
- `push.test` sends a test APNs push to a registered iOS node.
- `voicewake.get` returns the stored wake-word triggers.
- `voicewake.set` updates wake-word triggers and broadcasts the change.

### Channel DM pairing

`channels.pairing.list`, `channels.pairing.approve`, and
`channels.pairing.dismiss` manage channel DM access requests. They are separate
from [device bootstrap](/gateway/protocol/rpc-devices-nodes-and-approvals#device-pairing-and-device-tokens).

The existing list request accepts optional `channel` and `accountId` and returns
`accounts`, `requests`, `commandOwnerConfigured`, and `limits`. Public request
rows contain a `requestId` and sender/account metadata, never the pairing code.
Existing approval and dismissal use `channel`, `accountId`, and `requestId`;
approval also accepts `notify` and `bootstrapCommandOwner`. Approval returns
`requestId`, `senderId`, `notification`, and `commandOwnerBootstrap`; dismissal
returns `requestId` and `senderId`. These contracts remain unchanged.

The local CLI uses two explicit, `operator.admin`-protected branches after
negotiating the corresponding
[owner capability](/gateway/protocol/versioning#local-state-owner-routing):

| Method                     | Request                                                             | Result                                                                                              |
| -------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `channels.pairing.list`    | `format: "cli"`, `channel`, `expectedOwnerId`; optional `accountId` | Raw request array containing `id`, `code`, `createdAt`, `lastSeenAt`, and optional `meta`.          |
| `channels.pairing.approve` | `channel`, `code`, `expectedOwnerId`; optional `accountId`          | `{ id, entry }`, where `entry` is the raw approved request, or `null` when no pending code matches. |

The code selector and existing request-ID selector are mutually exclusive.
Omitting `accountId` in the CLI branch preserves cross-account listing and code
lookup; an explicit account restricts both. The owner resolves and mutates the
matching request. CLI output remains unchanged, and first-command-owner config
bootstrap and optional notification remain client-side after acknowledgement.
Neither runs after a refusal or unknown outcome. Listing is mutation-capable
because it prunes expired or excess pending requests.

## Plugin management

- `plugins.list` (`operator.read`) returns the installed plugin inventory plus locally curated official picks, diagnostics, and whether the current install mode allows mutations. It includes the current runtime `generation` and each plugin's runtime state separately from configured enablement.
- `plugins.inspect` (`operator.read`) accepts `{ pluginId }` for installed, staged, or official candidates; `{ source: "clawhub", packageName, version? }` for arbitrary ClawHub plugins; or `{ catalogId, version? }` using a discovery identity. Installed and staged inspections include a `reviewToken` for capability consent. Remote inspections expose the selected catalog detail, applicable grants, and release trust. Their `declaredSurfaceStatus` is `partial` or `unavailable`: registry summaries omit some capability groups and package siblings, so they cannot issue a consent token. Empty unsupported groups do not mean the package declares no such capabilities.
- `plugins.search` (`operator.read`) searches installable ClawHub code-plugin and bundle-plugin families. Pass non-empty `query` and optional `limit` from 1 to 100.
- `plugins.catalog.browse` (`operator.read`) returns ClawHub discovery results with Gateway-local installed and bundled state. The Control UI adds `searchSource: "openclaw-control-ui"` only after manual input of at least two characters settles for 250 ms. Initial browsing, refreshes, filter changes, and generic API searches omit it. The Gateway honors `CLAWHUB_DISABLE_TELEMETRY` and does not replay attributed HTTP searches after transient failures. ClawHub records the normalized query, source, and remote result counts; those counts exclude local-only matches added by the Gateway. Installed inventory and operator, device, and session identities are not included in the observation.
- `plugins.catalog.get` (`operator.read`) accepts `{ id, version? }` using the unchanged discovery ID from `plugins.catalog.browse`. Detail includes publisher metadata, README, topics, package tags, selected-release notes, capabilities, configuration, verification, and security when supplied by ClawHub. `detail.selectedRelease` names the actual release independently of `plugin.catalog.latestVersion`; null means no release was selected. `detail.metadata` explicitly reports available or missing README, manifest, and security data. An installed counterpart can supply local detail during registry outages; `remoteError` explains the failure, and remote selected-release facts remain unknown. Local-only identities do not support remote version selection.
- `plugins.install` (`operator.admin`) accepts these source-specific request fields:

  | `source`      | Fields                                                                     |
  | ------------- | -------------------------------------------------------------------------- |
  | `bundled`     | `pluginId`, optional `spec`                                                |
  | `clawhub`     | `packageName`, optional `version`, `expectedPluginId`, `expectedIntegrity` |
  | `git`         | `spec`                                                                     |
  | `local`       | `path`, optional `link`                                                    |
  | `marketplace` | `marketplace`, `plugin`                                                    |
  | `npm`         | `spec`, optional `pin`, `expectedPluginId`, `expectedIntegrity`            |
  | `npm-pack`    | `archivePath`                                                              |
  | `official`    | `pluginId`, optional `version: "latest"`, `pin`                            |

  Each request can also include `mode: "install" | "update"`, `acknowledgeInstallPolicyWarning: true`, and `acknowledgeCapabilities: { reviewToken }`. Omitted `mode` means install. Local paths, npm-pack archives, marketplace sources, and local Git sources require a connection the Gateway identifies as local; paths refer to that Gateway host. Use an npm spec for a specific official package version.

  When install policy returns `warn`, the error `details` include `installPolicyCode: "install_policy_warning_acknowledgement_required"`, the target, reason, and optional findings. After review, retrying the same action with `acknowledgeInstallPolicyWarning: true` approves every warning in that install invocation; each warning is freshly evaluated before installation continues. `block` and policy failures remain terminal. ClawHub installs preserve Gateway trust and integrity checks.

- `plugins.setEnabled` (`operator.admin`) changes one installed plugin's enabled policy with `{ pluginId, enabled, acknowledgeCapabilities? }`. The response includes the updated catalog entry and any slot-selection warnings.
- `plugins.reload` (`operator.admin`) reloads one or more discovered plugins with `{ plugins: [{ pluginId, installHash?, sourceDigests? }], acknowledgeCapabilities? }`, preserving configured enablement. Send 1–64 targets; a one-plugin request uses the same array envelope. The response contains `pluginIds`, a boolean `restartRequired`, and a required `runtime` receipt. When compiled bundled code retains its loaded module after its files change, `restartRequired` is `true` and the result explains why.
- `plugins.refresh` (`operator.admin`) refreshes plugin metadata and applies the resulting registry with `{}`.
- `plugins.uninstall` (`operator.admin`) removes one externally installed plugin with `{ pluginId, keepFiles? }`: config references, the install record, and managed files. Bundled plugins cannot be uninstalled, only disabled. The response lists the removal actions.

### Catalog detail and client confirmation

`detail.downloadability` has one of these shapes:

| Status                                         | Meaning                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `{ "status": "downloadable" }`                 | The source has confirmed selected-release artifact availability.       |
| `{ "status": "unavailable", "reason": "..." }` | A missing release or source download policy prevents download.         |
| `{ "status": "unknown", "reason": "..." }`     | The source cannot establish availability, or the registry read failed. |

ClawHub currently exposes a selected plugin release's download-policy block, but
its read-only detail and artifact resolver do not check stored artifact bytes.
A permitted security verdict, download URL, listing, or local install action
therefore produces `unknown`, never `downloadable`. A side-effect-free per-release
availability fact requires a ClawHub contract extension. Gateway inspection does
not download packages to check them; registry download routes record telemetry.

A native client can fetch `plugins.catalog.get`, inspect the same `catalogId`,
display the returned facts, and collect confirmation itself. After approval,
call `plugins.install` with `source: "clawhub"`, the exact returned `packageName`,
and `selectedRelease.version` when present. Preserve scope and publisher spelling;
do not rebuild the package name from a runtime plugin ID. If installation requires
capability consent or install-policy acknowledgment, display that owner-issued
review and retry the same intent with its acknowledgment. Catalog inspection does
not grant consent or bypass install policy, integrity, trust, or authorization.
Cancel sends no installation RPC. The Gateway does not manage confirmation dialogs.

Runtime-only refresh works with read-only, Nix-managed, and root `$include` configurations without rewriting them.
Plugin lifecycle and Claw package removal requests return retryable `UNAVAILABLE` with `retryAfterMs` when another plugin or config operation is already applying. This busy response occurs before the requested mutation starts; retry after the current operation completes. Failures after a mutation starts retain their application details and are not automatically retryable.

These mutations wait for runtime application without restarting the Gateway. Successful responses include `restartRequired` and a `runtime` receipt with `operationId`, `generation`, `pluginIds`, and optional `sourceDigests`. Reloading unchanged bundled code or replacing captured external code returns `restartRequired: false`; edited bundled code that remains loaded, or whose files cannot be verified, requires a restart. The Gateway broadcasts `plugins.changed` with `{ generation }` after publication. Runtime replacement errors include `details.runtime.phase` and `details.runtime.committed`, so clients can distinguish rejection before publication from failure after a new generation became active.

If a multi-step mutation publishes a runtime and later fails, `details.runtime` retains the published receipt with `committed: true`. A subsequent replacement that fails before publication is reported separately in `details.runtimeAttempt`. Clients should refresh their runtime view after any committed change, even when the overall mutation fails.

An install error can also include `details.persistence: { operation: "install", pluginId }`. This records that installation was saved, independently of runtime publication. Refresh the installed inventory and config; fix the reported problem and reload the installed plugin instead of blindly repeating installation. `details.runtime.committed: false` does not mean the installation was rolled back.

Install, enable, and reload may require capability consent. After reviewing the declared capabilities, pass `acknowledgeCapabilities: { reviewToken }`; the token is checked against a fresh inspection before application. This is separate from install-policy warning approval. See [Plugin management](/plugins/manage-plugins).

Reload preconditions are optional. `installHash` is the lowercase SHA-256 of the canonical saved install record and requires a tracked package. `sourceDigests` maps resolved runtime plugin IDs to lowercase SHA-256 source digests. Tracked targets resolve their entire package; a bundled or configured source without an install record resolves its discovered runtime ID. Ambiguous, missing, or conflicting managed ownership still rejects the request. The Gateway checks target ownership and expected records before and after consent, then validates source expectations against the captured code it loads. Consent can update the saved install record: if that changes a supplied `installHash`, reload fails visibly without publishing runtime. The caller must refresh its expected state before retrying; the Gateway never rewrites the supplied hash. An acknowledgment covers its reviewed declared surface, and a different required surface stops the operation before runtime publication. Reload does not rebuild compiled bundled code or grant file-mutation authority.

`sourceDigests` requires a captured-source plugin instance and Node's synchronous module hooks. Runtimes without those hooks, including Bun 1.4.2, omit these digests and reject requests that supply them. Ordinary Bun reloads capture fresh source for the replacement while retaining the old instance for admitted consumers; see [runtime instance and source lifetime](/plugins/architecture#runtime-instance-and-source-lifetime).

## Messaging and logs

- `send` is the direct outbound-delivery RPC for channel/account/thread-targeted sends outside the chat runner.
- `logs.tail` returns the configured gateway file-log tail with cursor/limit and max-byte controls.

## Operator terminal

- `terminal.open` starts a host PTY for an explicit `agentId` or the default agent and returns the resolved agent, working directory, shell, and confinement state. Passing `sessionKey` binds the PTY to that exact agent session and attaches the calling connection as its first viewer; omitting it creates a connection-owned operator terminal.
- `terminal.input` and `terminal.resize` operate on sessions owned by the calling connection and agent-owned sessions where that connection is an attached viewer. `terminal.close` kills a connection-owned session, but only detaches the calling viewer from an established agent-owned session. For a new session-bound Control UI terminal, the initiating viewer's close or disconnect discards the PTY until the browser or exact-session agent first adopts it through an authorized operation.
- `terminal.upload` accepts one base64 file up to 16 MiB, stages it in a private 24-hour temporary directory on the session's Gateway or paired-node host, and returns the absolute path. The caller must still paste or otherwise use that path; the RPC never writes terminal input or executes a command.
- `terminal.data` and `terminal.exit` events stream to the connection owner and attached viewers. Conversation-owned terminals remain persistent. The agent-facing `terminal` tool can list, read, resize, or close only terminals an operator opened for its exact session; it cannot open terminals. Agent input follows effective session and exec policy: `full` (YOLO) sends immediately, `guarded` and `workspace` (including accept-only or Guardian-reviewed flows) require explicit one-time approval of that exact input, and `read-only` or `deny` blocks it.
- Connection-owned sessions whose connection drops are detached, not killed: they stay reattachable for `gateway.terminal.detachedSessionTimeoutSeconds` (default 300; `0` restores kill-on-disconnect) while recent output accumulates in a bounded server-side buffer. Established agent-owned sessions likewise survive viewer disconnect.
- `terminal.list` returns attachable sessions. `terminal.attach` returns the replay buffer and either rebinds a connection-owned session (tmux-style take-over — a previous live owner receives `terminal.exit` with reason `detached`) or adds the connection as a viewer of an agent-owned session.
- Every terminal method requires `operator.admin`; `gateway.terminal.enabled` is on by default and refuses every method when set to `false`. Fully sandboxed agents are refused, and an agent policy change closes existing and in-flight PTYs, detached ones included.
