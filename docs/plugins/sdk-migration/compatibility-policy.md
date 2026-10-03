---
summary: "The external-plugin compatibility policy and the dated per-surface compatibility records"
read_when:
  - You need to know whether a compatibility surface is still supported
  - You are checking the removal condition for a specific retained contract
title: "Compatibility policy and records"
sidebarTitle: "Compatibility records"
---

The order compatibility work follows, and the per-surface records that say what is retained, why, and on what condition it can be removed. Part of the [Plugin SDK migration](/plugins/sdk-migration) guide.

## Compatibility policy

External-plugin compatibility work follows this order:

1. Add the new contract.
2. Keep the old behavior wired through a compatibility adapter.
3. Emit a diagnostic or warning naming the old path and replacement.
4. Cover both paths in tests.
5. Document the deprecation and migration path.
6. Remove only after the announced migration window, usually in a major
   release.

### Retained helper contracts

Discord and llama.cpp retain their declared OpenClaw 2026.9.2 host support.
They use the newer prepared-expiry, DM-policy refinement, and live-catalog outcome
helpers when those exports are available, with plugin-local fallbacks for the
2026.9.2 SDK. The fallbacks preserve Discord's timestamp validation, idle-first
expiry ties, and root/account DM-policy validation through the older SDK
validators, and llama.cpp's ready, authentication-rejected, and unavailable catalog outcomes
with credential-profile attribution. They do not retry or suppress errors from
an available newer helper. Remove these fallbacks only when the declared plugin
API floor no longer includes 2026.9.2; test built plugin imports against that
minimum host before changing unconditional SDK imports.

Voice Call also retains its declared 2026.9.2 host support. Its realtime upgrade
handler keeps the two HTTP rejection responses local because that SDK has no
`websocket-runtime` subpath. Rejection bytes flush before the socket is destroyed,
and socket errors retain their normal cleanup behavior. Remove this local
transport compatibility code only when the declared plugin API floor excludes
2026.9.2.

Retained compatibility entrypoints keep their shipped caller names:
`inbound-envelope` uses `resolveStorePath`, `provider-catalog-runtime` exports
`resolvePluginProviders`, and `agent-runtime`'s
`resolveThinkingDefaultWithRuntimeCatalog` accepts `loadModelCatalog`.

`resolvePluginProviders` remains synchronous and returns the existing provider
array. When it borrows from an owned inspection, the Gateway lifecycle or
executable CLI invocation retains the backing resources until its actual work
and cleanup finish. Finish calls using those providers before the host closes;
keeping the array does not authorize use after host retirement. A released
inspection stays retired, and a new lookup through that inspection is refused.
Callers outside an OpenClaw host retain the standalone process lifetime of this
SDK contract; process exit does not guarantee asynchronous plugin disposal.

Inspection release relinquishes the inspection's own claim. If an SDK host
still borrows the same source, final disposal belongs to that host. The host
reports later disposal failures during teardown; they cannot retroactively
change an already returned inspection result. Internal provider resolvers do
not acquire this compatibility lifetime.

`text-chunking` retains positional `CodeRegion` inputs with `start` and `end`
offsets for `isInsideCode`. Regions returned by `findCodeRegions` additionally
include parser-owned `block` metadata; callers supplying their own ranges do not
need to provide it.

### WebSocket options and constructors

`websocket-runtime` retains the `ws.ClientOptions` alias and `WebSocket`
constructor signatures shipped in OpenClaw 2026.9.6. Host-internal TLS type
corrections must not change plugin callback typing or constructor overloads.
A source-incompatible correction to this public contract requires an approved,
versioned SDK migration.

### Gateway worker environment creation

`GatewayRequestHandlerOptions` from `core` and `gateway-runtime` retains the
worker-environment creation contract shipped in OpenClaw 2026.9.5. When
`context.workerEnvironmentService` is available, its `create` method accepts
positional arguments in this order: `profileId`, `idempotencyKey`, `machineClass?`,
`executionMode?`, `projectPath?`, `signal?`, `os?`, and `runSetupScript?`.
Idempotent retries and caller cancellation keep their existing behavior across
host upgrades. Changing this contract requires an explicitly approved SDK
migration.

### Gateway placement and publication readers

The Gateway context exposed by `GatewayRequestHandlerOptions` from `core` and
`gateway-runtime`, and by `getPluginRuntimeGatewayRequestScope()` from
`plugin-runtime`, retains these synchronous contracts shipped in OpenClaw
2026.9.7:

- `workerSessionPlacementService.listPendingWorkspaceResults(sessionId?)`
  returns the pending result array.
- `workerSessionPlacementService.getWorkspaceResultReconcilingSessionIds(sessionIds)`
  returns a `ReadonlySet<string>`.
- `githubPublicationService.deferOrphanedRequests()` returns `void` after
  orphaned requests have been deferred.

Migrate to the corresponding `Async`-suffixed methods and await their results.
The placement readers use the SQLite worker. Internal callers use the awaited
methods; the synchronous adapters remain solely for released plugin contracts.
TypeScript marks those adapters deprecated. They retain their result shapes and
completion timing until the next Plugin SDK major and an explicitly approved
breaking release. No schema, retained data, or update migration changes.

### Harness attempt result migration

In OpenClaw 2026.8.1, `EmbeddedRunAttemptResult` from
`openclaw/plugin-sdk/agent-harness-runtime` requires the canonical `terminal`
field. Source written against the 2026.7 direct alias must migrate when it
constructs results with legacy fields such as `aborted`, `timedOut`, and
`promptError`; retaining the alias name does not make those old constructors
source-compatible.

Use `AgentHarnessAttemptResult` from the same subpath while migrating a
legacy result producer. That union accepts both the legacy fields and the
canonical result, and the host lifecycle normalizes legacy results before
core consumes them. New producers should construct `terminal`; consumers of
the union must narrow the result before reading it. The current
`EmbeddedRunAttemptResult` contract keeps `terminal` required.

### Mention Inbox persistence

The October 3, 2026 `mention-inbox-sync-persistence` record retains the
synchronous `mentionInbox.list(client)` and `mentionInbox.dismiss(client, ids)`
contracts exposed through the Gateway Plugin SDK context. Their result shapes,
exact-ID matching, and immediate completion remain supported until the next
Plugin SDK major and explicit breaking-release approval.

Use `listAsync` and `dismissAsync` with their synchronous result-publication
callbacks; see [awaited Mention Inbox operations](/plugins/sdk-migration/how-to-migrate#await-mention-inbox-operations).
Core and bundled callers use these worker-backed methods. Legacy calls emit one
`DEP_SESSION_PERSISTENCE` warning per plugin and method per process, with a
once-per-method warning for unscoped calls. Schemas, retained data, and update
behavior are unchanged.

### Awaited session persistence

The October 1, 2026 records `session-manager-sync-persistence`,
`extension-session-sync-persistence`, and `provider-replay-sync-persistence`
retain the shipped synchronous transcript contracts as named third-party
compatibility adapters. Their removal gate is `next-plugin-sdk-major`, with no
calendar removal date. Existing exports and immediate return values remain
available while plugins migrate; synchronous SessionManager methods warn once
per method per process.

Use the [awaited session persistence migration](/plugins/sdk-migration/how-to-migrate#await-session-transcript-persistence)
for the complete method mapping, extension calls, and versioned provider replay
types. Bundled code uses the awaited contracts. File-backed writes reuse the
canonical worker writer; incognito retains its process-local owner until its
separate cutover. Schemas, persisted bytes, and supported update paths are
unchanged. Removal still requires explicit breaking-release approval.

### Model-provider result compatibility

`openclaw/plugin-sdk/models-provider-runtime` preserves the `ModelsProviderData`
construction shape and `buildModelsProviderData` return signature published in
`v2026.7.1-2`, including typed adapters that return that shape. These contracts
remain supported until an explicitly approved SDK-breaking boundary.

Call `buildPreparedModelsProviderData` when forwarding model selections. Its
result includes the required `modelCatalog` with
the selected physical-route metadata. Both builders use one metadata producer;
callers must carry prepared rows forward rather than reconstructing them from IDs.

Both builders return the currently published menu rows without waiting for full
discovery. Results may be partial while acquisition continues in the background;
`pendingProviders` identifies providers still refreshing. Keep known choices usable
and call the builder again when the menu is reopened. Awaiting a menu builder is
not a complete-inventory guarantee. Use the catalog's explicit refresh operation
when requesting inventory acquisition rather than treating a menu read as one.

Use `getModelsRuntimeChoices(data, provider, model)` from the same SDK subpath
for a selected model. A nonempty array contains that model's eligible runtime
choices. An empty array means the current observation permits no runtime for
that model. `undefined` means the choice is unknown: the model has no observation,
the caller supplied the older result shape, or `data.isCurrent()` reports that
the prepared owner has retired. Do not replace either result with a provider
default or a runtime inferred from its name. Refresh retired data through its
owning catalog before selecting again.

Omitting `model` returns the provider's browsing union. That union does not
authorize a runtime for every model in the provider. Pass `sessionEntry` to the
builder when browsing for a session so its profile preference, explicit profile
pin, and runtime override participate in the choices. Keep the prepared physical
row and revalidate the selection through the normal command owner; a displayed
choice is not authority to use a retired generation or bypass a session lock.

Provider plugins can publish native login presence through `prepareSyntheticAuth`
with `nativeAuth: { runtime, mode }`, where `mode` is `api-key`, `oauth`, or
`token`. These facts apply only to the named runtime in the prepared generation.
They do not supply a provider bearer credential or authorize importing one into
an OpenClaw profile. The optional `pluginRoot` context comes from the plugin
loader; use it to resolve the declared dependency from that plugin's installation.

### Memory session inventory readers

`loadArchivedSessions` and `resolveMemorySessionTargets` from
`openclaw/plugin-sdk/memory-core-host-engine-sessions` are deprecated as of
October 1, 2026. Await `loadArchivedSessionsAsync` and
`resolveMemorySessionTargetsAsync` from the same subpath. The replacements
run durable archive and selector reads in the retained session worker and
preserve selection, ordering, missing-store behavior, and result shapes.
Process-held incognito stores keep their native owner.

Bundled memory search and memory-forget use the awaited readers. The synchronous
exports retain their signatures and behavior for existing consumers until removal
at the next Plugin SDK major. Deprecation is communicated through JSDoc and the
compatibility registry; these readers emit no runtime warnings.

### Memory read missing results

Memory managers now return `status: "ok"` for successful excerpts and
`status: "not_found"` when an allowed file is missing. This keeps empty files
and empty ranges distinct from missing files without relying on pagination
metadata.

At registration, every statusless result from an older external memory manager
preserves its legacy successful-read semantics and becomes `status: "ok"`,
including empty results without range metadata. Only an explicit
`status: "not_found"` reports absence. New producers must emit that status for
missing files; registered-input normalization remains available through the
next Plugin SDK major.

### Config record migrations

Use `mergeMissing(canonical, legacy)` from
`openclaw/plugin-sdk/runtime-doctor-migrations` to fill undefined fields without
replacing authored values. It fills existing nested records in place and keeps
authored arrays, nulls, and scalars. Missing values are assigned by reference;
callers own any cloning needed to isolate the migration from its input.

The helper skips undefined source values and `__proto__`, `prototype`, and
`constructor` keys at each level it merges. It does not recursively sanitize
newly assigned subtrees.

### Plugin state migration declarations

Bundled plugins should list every migration under
`doctorContract.stateMigrations` in `openclaw.plugin.json` and export the
matching `stateMigrations` array from their doctor-contract artifact. Keep the
IDs, order, `doctorOnly` flags, and phases identical. Read-only Doctor planning
uses candidate-bundled descriptors to record exact plugin owners without
loading the plugin.

Installed external plugin artifacts are not part of the copied-state or
candidate content identity. Copied-state planning refuses their migrations,
including manifests that contain descriptor arrays, until candidate validation
binds those artifacts separately. The legacy value `true` continues to locate
their dynamic contract for non-planning Doctor flows.

Plan-based migrations can use
`definePluginDoctorMigrationFromPlans(...)` from
`openclaw/plugin-sdk/runtime-doctor-migrations` to preserve existing move, copy, preview,
and plugin-state import behavior.

Migrations may supply a read-only `collectBackupResources` callback, including
through `definePluginDoctorMigrationFromPlans(...)`. Return absolute paths with
kind `sqlite`, `file`, or `directory`, including destinations that do not exist
yet. Never open a writable store or run the migration during inventory. When
`requireLocalResources` is true, reject remote or unlisted data rather than
reporting an incomplete inventory as complete.

The recovery inventory collector reports one typed
`undeclared-migration-resources` warning per plugin without a callback; its
private state is not included in the recovery set. Malformed declarations and
invalid inventories still fail. Collection does not capture or restore data,
authorize a migration, or replace an updater's required capture checks.

For single-file imports, `defineLegacyJsonStateMigration(...)` skips missing
sources (`ENOENT`) and values the plugin parser rejects with `null`. Other read
errors and invalid JSON reach Doctor's detection or migration warnings; the
source remains untouched so the operator can fix it and retry.

For a format outside the [supported upgrade window](/gateway/doctor/config-migrations#retention-policy),
use `defineRetiredPluginStateMigration({ id, label, intermediateVersion, findSources })`
from the same facade. The plugin supplies absolute candidate paths or immediate
directory selections `{ directory, prefix?, suffix }`; the helper checks existence
without parsing or changing source bytes. Missing paths are ignored; other read
errors remain failures. Doctor reports a refusal naming the intermediate release
and retained files. Supply `recoveryInstructions` when the bridge requires an
owner-specific step beyond Doctor. Its `assertSupportedState(input, sources?)` operation applies
the same check at runtime admission; a caller with an already selected file may
pass that path explicitly. Keep account and workspace discovery with the plugin.

Use `phase: "after-session-repair"` when a migration needs canonical session
ownership evidence. Ordinary Doctor detects these migrations; `--fix` applies
them after session repair under SQLite maintenance ownership. The context
provides bounded `readPluginStateEntriesInKeyRange` and
`readSessionIdentityEvidenceBatch` reads, plus
`deletePluginStateEntriesIfUnchanged` only during a fenced repair. Preserve
unknown or ambiguous ownership. Delete only the observed raw rows; callbacks
retained after maintenance ends cannot authorize later writes.

Trusted bundled and official plugins may also use the optional
`inspectCronJobs` and `repairCronJobs` context methods for explicit cron
migrations. Inspection is non-creating and returns raw definitions, row IDs,
ordering, validation findings, and store keys for every persisted partition.
`repairCronJobs(inventory, changes)` is available only during offline repair:
it saves a verified shared-state SQLite backup, rechecks current authority and
the inspected definitions, then applies all selected replacements or deletions
in one transaction. A replacement preserves the row ID, partition, ordering,
and runtime state. A deletion uses normal cron scratch and grant cleanup.
The result reports `changed` and the retained `backupPath`; a no-op creates no
backup. Plugins classify their own historical jobs and retain ambiguous rows.
Older hosts may omit these methods, so a migration must check availability.

These helpers follow the [native-plugin trust model](/plugins/architecture#execution-model):
eligible plugins run with host privileges and own historical job classification.
The host enforces installation provenance, offline repair authority, unchanged
definitions, verified backup, and atomic persistence. The API does not promise
isolation between mutually untrusted native plugins.

The setup-entry `legacyStateMigrations` option and feature flag,
`setupFeatures.legacyStateMigrations`,
`BundledChannelLegacyStateMigrationDetector`, and
`ChannelPlugin.lifecycle.detectLegacyStateMigrations` remain supported through
one doctor-pipeline adapter for external plugins, but are deprecated. Removal
plan: remove that adapter after OpenClaw 2027.1 only when a published-plugin
reader sweep finds no remaining users.

### AuthStorage SQLite migration

`AuthStorage.forAgent(agentDir)` is the canonical constructor for host session
storage. It persists provider-default credentials through the agent's
`openclaw-agent.sqlite` auth-profile rows and never creates `auth.json`.
Harness plugins receive the prepared storage instance as `params.authStorage`.

`AuthStorage.create(authPath)` remains as a named deprecated adapter for
existing plugins. The path is used only to derive the owning agent directory;
the adapter reads and writes SQLite, not the named JSON file. Migrate to
`forAgent(...)` now. The path-taking form emits
`AUTH_STORAGE_CREATE_DEPRECATED` and is eligible for removal after
2026-10-01, provided the published-plugin reader sweep is clean.

`FileAuthStorageBackend` is an internal SQLite-backed adapter, not an exported
Plugin SDK backend. It is not available as a named import from
`openclaw/plugin-sdk/agent-sessions`. Harness plugins should use the
host-prepared `params.authStorage`; host code that constructs storage should
use `AuthStorage.forAgent(agentDir)`. The internal adapter emits
`FILE_AUTH_STORAGE_BACKEND_DEPRECATED` and never reads or writes the legacy
file. Its internal deprecation window does not preserve the former SDK import.

If a manifest field is still accepted, keep using it until docs and
diagnostics say otherwise. New code should prefer the documented replacement;
existing plugins should not break during ordinary minor releases.

The dated compatibility registry also tracks shipped annotations that do not
belong to one legacy subpath. Unless a later date is listed below, these records
use 2026-10-01 as the earliest review date; removal still requires the reader
condition in the final column. The October 1 families are `removal-pending`
while those migrations remain unverified; their original dates are unchanged.

| Compatibility code                                | Replacement                                                       | Removal condition                                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `plugin-sdk-broad-runtime-barrels`                | Focused capability subpaths                                       | No bundled or published imports of the seven enumerated broad barrels remain.                                        |
| `plugin-sdk-provider-owned-helper-shims`          | Provider-local auth/model/replay/OAuth/stream APIs                | Every enumerated helper is migrated in official providers and absent from published plugins.                         |
| `message-presentation-legacy-bridges`             | `MessagePresentation` and channel presentation renderers          | Producers and official channel packages no longer emit or read legacy interactive replies.                           |
| `plugin-sdk-focused-compat-aliases`               | The focused replacement named by each `@deprecated` annotation    | Every enumerated alias has zero bundled and published readers.                                                       |
| `agent-harness-terminal-result-aliases`           | `AgentHarnessAttemptResult.terminal` and `visibleReplies`         | Harness plugins no longer read legacy terminal booleans or `sourceVisibleReplies`.                                   |
| `official-plugin-export-aliases`                  | Presentation renderers and host-owned Discord timeout behavior    | Minimum supported official plugin packages no longer import the aliases.                                             |
| `memory-host-compatibility-aliases`               | Canonical memory cache/FTS tables                                 | Supported artifacts no longer pass table overrides, and legacy table data remains preserved.                         |
| `plugin-runtime-api-compat-aliases`               | Namespaced plugin APIs and focused runtime methods                | All enumerated flat API/runtime aliases have no readers.                                                             |
| `plugin-provider-manifest-compat-aliases`         | Manifest-owned kind/setup metadata and model catalog registration | Providers no longer publish runtime kind or legacy catalog hooks.                                                    |
| `agent-harness-credential-prompt-string-argument` | Options object `{ controlToolsAvailable }`                        | Deprecated and warnings start 2026-09-09; supported through 2026-11-30. Remove after that date once callers migrate. |

The deprecated GitHub Copilot token-exchange exports have been removed from
`provider-auth`: `DEFAULT_COPILOT_API_BASE_URL`, `deriveCopilotApiBaseUrlFromToken`,
`resolveCopilotApiToken`, and `CachedCopilotToken`. The GitHub Copilot plugin owns
authentication and account endpoint resolution; provider integrations should
use their registered auth hooks instead of the retired `/v2/token` exchange.
`normalizeGithubCopilotDomain` remains available.

Update plugins that import the removed exports before updating the host. This
removal does not rewrite credentials, delete existing cache entries, or change
the current GitHub Copilot plugin's authentication flow.

The deprecated `sourceVisibleReplies` delivery default remains supported for
July 2026 `@openclaw/codex` plugins. Migrate to
[`deliveryDefaults.visibleReplies`](/plugins/sdk-agent-harness/sessions-and-results#harness-delivery-defaults).
Published-plugin checks must include supported older versions: updates can
retain an older or linked plugin package.

Eight deprecated stream and replay hook constants have been removed. Construct
the same hooks with `buildProviderStreamFamilyHooks` from `provider-stream-family`
or `buildProviderReplayFamilyHooks` from `provider-model-shared`:

| Removed constant                   | Constructor argument               |
| ---------------------------------- | ---------------------------------- |
| `GOOGLE_THINKING_STREAM_HOOKS`     | `"google-thinking"`                |
| `KILOCODE_THINKING_STREAM_HOOKS`   | `"kilocode-thinking"`              |
| `MINIMAX_FAST_MODE_STREAM_HOOKS`   | `"minimax-fast-mode"`              |
| `OPENAI_RESPONSES_STREAM_HOOKS`    | `"openai-responses-defaults"`      |
| `OPENROUTER_THINKING_STREAM_HOOKS` | `"openrouter-thinking"`            |
| `TOOL_STREAM_DEFAULT_ON_HOOKS`     | `"tool-stream-default-on"`         |
| `ANTHROPIC_BY_MODEL_REPLAY_HOOKS`  | `{ family: "anthropic-by-model" }` |
| `OPENAI_COMPATIBLE_REPLAY_HOOKS`   | `{ family: "openai-compatible" }`  |

The stream constants are removed from both `provider-stream` and
`provider-stream-family`. Update plugins that import them before updating the
host. The constructors retain their existing behavior; this removal does not
change stored config, credentials, or session data.

`MOONSHOT_THINKING_STREAM_HOOKS` remains on both stream subpaths for published
Moonshot providers. `NATIVE_ANTHROPIC_REPLAY_HOOKS` and
`PASSTHROUGH_GEMINI_REPLAY_HOOKS` remain on `provider-model-shared` for published
Anthropic Vertex and Kilocode providers. Their `2026.7.1` and `2026.7.33` through
`2026.7.35` packages still import these names. The constructors are preferred
for new code, but these aliases retain their reader-dependent removal condition.

The unused private memory-host `loadConfig` re-exports have been removed.
Memory implementations use `getRuntimeConfig` or caller-provided config;
custom-table migration behavior remains intact.

### Published channel setup compatibility

Slack, Discord, Signal, and Microsoft Teams packages published through
`2026.7.1` import channel-specific config schemas from
`openclaw/plugin-sdk/bundled-channel-config-schema`. The published Slack and
Discord packages also import `createLegacyCompatChannelDmPolicy` and
`promptLegacyChannelAllowFromForAccount` from
`openclaw/plugin-sdk/setup-runtime`.

Those exports remain available as deprecated runtime compatibility adapters.
New and republished plugins should own their config schemas and setup policy
locally, using generic primitives from `channel-config-schema` and
`setup-runtime`. The compatibility exports can be removed only after the
minimum supported published package versions no longer import them.

### Channel setup input field compatibility

`ChannelSetupInput` now keeps only the cross-channel setup envelope typed
permanently. Channel-specific fields remain typed in a deprecated compatibility
tier so existing external plugins still compile while plugin authors move those
fields into plugin-local setup input types.

OpenClaw does not ship major releases. A registry sweep on 2026-07-22 inspected
426 published out-of-tree channel plugins and removed 21 fields with no readers.
The 22 retained fields each have a known published reader. Each further field is
deleted as soon as no published plugin reads it; the retained set shrinks as
plugin authors migrate to plugin-local setup input types.

The same sweep removed 23 legacy undeclared-adapter promotion keys with no
published dependents. Six common keys and the setup-only `rooms` key remain.
That set also shrinks as published plugins declare `singleAccountKeysToMove`.

The shared type has no index signature. Plugin-owned keys can still be present
on runtime input objects; declare them in a plugin-local intersection or narrow
them through the owning plugin's setup schema.

| `code`                                  | `owner`   | `replacement`                                                                                    | Removal condition                                                     |
| --------------------------------------- | --------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `plugin-sdk-channel-setup-input-fields` | `channel` | Intersect `ChannelSetupInput` with a plugin-local type that declares the owning channel's fields | Delete a field when the published-plugin registry sweep has no reader |

The legacy undeclared-adapter promotion tier follows the same reader-driven
policy. Declare `singleAccountKeysToMove`, including an empty array when the
plugin needs no extra promotion keys, so the shared fallback can be retired one
key at a time.

#### Verifying readers

1. Page through `https://clawhub.ai/api/v1/packages?family=code-plugin&limit=100` with each `nextCursor`, and keep packages whose `categories` include `channels`.
2. Add npm candidates from `npm search --json --searchlimit=1000 "openclaw channel plugin"`. Add source-only candidates from GitHub code searches for `openclaw/plugin-sdk/channel-setup`, `openclaw/plugin-sdk/setup`, and `openclaw/plugin-sdk/core`.
3. Resolve each candidate's latest published version. Run `npm pack <package>@<version> --json --pack-destination <temp-dir>`, unpack it, and inspect shipped `dist` JavaScript and declarations for direct or destructured field reads. Download the ClawHub artifact when a package has no npm release.
4. Record package, version, field or promotion key, and matching file. A field or key is deletable only when no published plugin artifact reads it. Keep the reader names in the code comments beside the retained field and key lists synchronized with the sweep.

This is a source/type compatibility record only. The registry entry has
`removeAfter: 2026-10-01`, but setup input runtime objects and behavior are
unchanged. The date starts a review; each field remains until its published
artifact reader count is zero.

Audit the current migration queue with `pnpm plugins:boundary-report`:

| Flag                                                    | Effect                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `--summary` (or `pnpm plugins:boundary-report:summary`) | Compact counts instead of full detail.                                                             |
| `--json`                                                | Machine-readable report.                                                                           |
| `--owner <id>`                                          | Filter to one compatibility owner.                                                                 |
| `--fail-on-eligible-compat`                             | Exit non-zero for dated `deprecated` records starting at 00:00 UTC on the day after `removeAfter`. |

`pnpm plugins:boundary-report:ci` runs with the compatibility fail flag.
For dated `deprecated` records, `removeAfter` is the final compatibility day:
`2026-09-01` becomes eligible at `2026-09-02T00:00:00Z`, not at the start of
September 1. `removal-pending` records are separate: they become due for review
at 00:00 UTC on their `removeAfter` date and are reported with blockers, but do
not trigger this fail flag. Neither state authorizes automatic removal.

Deprecated records normally have an explicit `removeAfter` date. A contract
tied to a version boundary instead declares a `removalGate`;
`next-plugin-sdk-major` is an approved major-version gate, not a pending owner
decision, and is never date-eligible. A record with neither field appears as
`no-date` and remains ineligible until its owner publishes a gate. The report
displays either the date or named gate, counts local code/doc references, lists
`removal-pending` records with their blockers and surface-token reader
references, and summarizes the private memory-host SDK bridge. Those reader
references are triage signals, not published-artifact proof.

### Media legacy projection

The `media-legacy-projection` compatibility record covers the old parallel
media fields, payload builders, hook metadata aliases, and media template
names. Its approved `removeAfter` date is **2026-10-01** (two release trains
after the facts-first replacements shipped). Removal additionally requires a
clean published-plugin artifact sweep. The record is now `removal-pending`
with the original date preserved until that proof is complete.

The unused `buildChannelTurnMediaPayload` alias has been removed from
`openclaw/plugin-sdk/channel-inbound`. Its canonical
`buildChannelInboundMediaPayload` export remains available for the compatibility
window above. New ingress code should pass ordered media facts directly.

For channel ingress, replace singular/plural `MediaPath`, `MediaUrl`,
`MediaType`, `MediaPaths`, `MediaUrls`, `MediaTypes`,
`MediaTranscribedIndexes`, `MediaWorkspaceDir`, and `MediaStaged` with ordered
facts:

```ts
import { toInboundMediaFacts } from "openclaw/plugin-sdk/channel-inbound";

const media = toInboundMediaFacts([
  { path: saved.path, url: nativeUrl, contentType: saved.contentType, messageId },
]);

const ctx = finalizeInboundContext({ Body: caption, media });
```

Use `event.media` in `inbound_claim` and `message_received` hooks. If remote
media is not locally staged, use `event.originalMedia` for identity/diagnostics
and wait for `event.media`; `event.mediaStagingPending` distinguishes that
state. Do not read the deprecated singular/plural properties from
`event.metadata`.

For CLI media models, replace `{{MediaPath}}`, `{{MediaUrl}}`, `{{MediaType}}`,
and `{{MediaDir}}` with `{{AttachmentPath}}`, `{{AttachmentUrl}}`,
`{{AttachmentContentType}}`, and `{{AttachmentDir}}`. Use
`{{AttachmentIndex}}` when attachment position matters.

For local media read policy, import `getAgentScopedMediaLocalRoots(...)` or
`getAgentScopedMediaLocalRootsForSources(...)` from
`openclaw/plugin-sdk/media-local-roots`. The
`openclaw/plugin-sdk/agent-media-payload` facade and its
`buildAgentMediaPayload(...)` projection are deprecated.
