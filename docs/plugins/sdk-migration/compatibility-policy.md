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

`text-chunking` retains positional `CodeRegion` inputs with `start` and `end`
offsets for `isInsideCode`. Regions returned by `findCodeRegions` additionally
include parser-owned `block` metadata; callers supplying their own ranges do not
need to provide it.

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

### Model-provider result compatibility

`openclaw/plugin-sdk/models-provider-runtime` preserves the `ModelsProviderData`
construction shape and `buildModelsProviderData` return signature published in
`v2026.7.1-2`, including typed adapters that return that shape. These contracts
remain supported until an explicitly approved SDK-breaking boundary.

Call `buildPreparedModelsProviderData` when forwarding model selections. Its
result includes the required `modelCatalog` with
the selected physical-route metadata. Both builders use one metadata producer;
callers must carry prepared rows forward rather than reconstructing them from IDs.

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

For single-file imports, `defineLegacyJsonStateMigration(...)` skips missing
sources (`ENOENT`) and values the plugin parser rejects with `null`. Other read
errors and invalid JSON reach Doctor's detection or migration warnings; the
source remains untouched so the operator can fix it and retry.

Use `phase: "after-session-repair"` when a migration needs canonical session
ownership evidence. Ordinary Doctor detects these migrations; `--fix` applies
them after session repair under SQLite maintenance ownership. The context
provides bounded `readPluginStateEntriesInKeyRange` and
`readSessionIdentityEvidenceBatch` reads, plus
`deletePluginStateEntriesIfUnchanged` only during a fenced repair. Preserve
unknown or ambiguous ownership. Delete only the observed raw rows; callbacks
retained after maintenance ends cannot authorize later writes.

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
belong to one legacy subpath. These records use 2026-10-01 as the earliest
review date; removal still requires the reader condition in the final column.

| Compatibility code                        | Replacement                                                                                    | Removal condition                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `plugin-sdk-broad-runtime-barrels`        | Focused capability subpaths                                                                    | No bundled or published imports of the seven enumerated broad barrels remain.                |
| `plugin-sdk-provider-owned-helper-shims`  | Provider-local auth/model/replay/OAuth/stream APIs                                             | Every enumerated helper is migrated in official providers and absent from published plugins. |
| `message-presentation-legacy-bridges`     | `MessagePresentation` and channel presentation renderers                                       | Producers and official channel packages no longer emit or read legacy interactive replies.   |
| `plugin-sdk-focused-compat-aliases`       | The focused replacement named by each `@deprecated` annotation                                 | Every enumerated alias has zero bundled and published readers.                               |
| `agent-harness-terminal-result-aliases`   | `AgentHarnessAttemptResult.terminal` and `visibleReplies`                                      | Harness plugins no longer read legacy terminal booleans or `sourceVisibleReplies`.           |
| `official-plugin-export-aliases`          | Canonical Google Meet testing, presentation renderers, and host-owned Discord timeout behavior | Minimum supported official plugin packages no longer import the aliases.                     |
| `memory-host-compatibility-aliases`       | Canonical memory tables and prepared runtime config                                            | Memory integrations no longer pass table overrides or call legacy `loadConfig`.              |
| `plugin-runtime-api-compat-aliases`       | Namespaced plugin APIs and focused runtime methods                                             | All enumerated flat API/runtime aliases have no readers.                                     |
| `plugin-provider-manifest-compat-aliases` | Manifest-owned kind/setup metadata and model catalog registration                              | Providers no longer publish runtime kind or legacy catalog hooks.                            |

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
clean published-plugin artifact sweep at that time; migrate before the date.

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
