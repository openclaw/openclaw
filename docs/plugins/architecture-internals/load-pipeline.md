---
summary: "How OpenClaw discovers, gates, loads, and registers plugins, and what the plugin cache holds"
read_when:
  - Debugging plugin load order or registry state
  - You need to know when OpenClaw reads manifests instead of loading plugin runtime
  - You are reasoning about plugin cache generations and what they retain
title: "Plugin load pipeline and registry"
sidebarTitle: "Load pipeline and registry"
---

Discovery, safety gates, manifest-first metadata, the plugin cache boundary, and
the registry that core reads from. Part of the [Plugin architecture
internals](/plugins/architecture-internals) guide.

## Load pipeline

At startup, OpenClaw does roughly this:

1. discover candidate plugin roots
2. read native or compatible bundle manifests and package metadata
3. reject unsafe candidates
4. normalize plugin config (`plugins.enabled`, `allow`, `deny`, `entries`,
   `slots`, `load.paths`)
5. decide enablement for each candidate
6. load enabled native modules: built bundled modules use a native loader;
   third-party local source TypeScript uses the emergency Jiti fallback
7. call native `register(api)` hooks and collect registrations into the plugin registry
8. expose the registry to commands/runtime surfaces

Safety gates run **before** runtime execution. Discovery blocks a candidate
when:

- its resolved entry escapes the plugin root
- its path (or its root directory) is world-writable
- for non-bundled plugins, path ownership does not match the current uid (or root)

World-writable bundled directories get an in-place `chmod` repair attempt
first (npm/global installs can ship package dirs at `0777`) before the gate
re-checks; ownership checks are skipped for bundled origin entirely.

Blocked candidates still carry their plugin id in the emitted diagnostic when
one is known (including ids resolved from a manifest inside an
otherwise-rejected directory), so config referencing that id sees a blocked
plugin tied to a path-safety warning instead of an unrelated "unknown plugin"
error.

### Manifest-first behavior

The manifest is the control-plane source of truth. OpenClaw uses it to:

- identify the plugin
- discover declared channels/skills/config schema or bundle capabilities
- validate `plugins.entries.<id>.config`
- augment Control UI labels/placeholders
- show install/catalog metadata
- preserve cheap activation and setup descriptors without loading plugin runtime

For native plugins, the runtime module is the data-plane part. It registers
actual behavior such as hooks, tools, commands, or provider flows.

Optional manifest `activation` and `setup` blocks stay on the control plane.
They are metadata-only descriptors for activation planning and setup discovery;
they do not replace runtime registration, `register(...)`, or `setupEntry`.
Live activation consumers use manifest command, channel, and provider hints to
narrow plugin loading before broader registry materialization:

- CLI loading narrows to plugins that own the requested primary command
- channel setup/plugin resolution narrows to plugins that own the requested
  channel id
- explicit provider setup/runtime resolution narrows to plugins that own the
  requested provider id
- Gateway startup planning uses `activation.onStartup` for explicit startup
  imports; plugins without startup metadata load only through narrower
  activation triggers

The activation planner exposes both an ids-only API for existing callers and a
plan API for diagnostics. Plan entries report why a plugin was selected,
separating explicit `activation.*` hints from manifest-ownership fallback:

| Reason (from `activation.*` hints)   | Reason (from manifest ownership)                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `activation-agent-harness-hint`      | —                                                                                            |
| `activation-capability-hint`         | —                                                                                            |
| `activation-channel-hint`            | `manifest-channel-owner` (`channels`)                                                        |
| `activation-command-hint`            | `manifest-command-alias` (`commandAliases`)                                                  |
| `activation-provider-hint`           | `manifest-provider-owner` (`providers`), `manifest-setup-provider-owner` (`setup.providers`) |
| `activation-route-hint`              | —                                                                                            |
| — (hook trigger has no hint variant) | `manifest-hook-owner` (`hooks`), `manifest-tool-contract` (`contracts.tools`)                |

That reason split is the compatibility boundary: existing plugin metadata
keeps working, while new code can detect broad hints or fallback behavior
without changing runtime loading semantics.

Request-time runtime preloads that ask for the broad `all` scope still derive
an explicit effective plugin id set from config, startup planning, configured
channels, slots, and auto-enable rules
(`resolveEffectivePluginIds` in `src/plugins/effective-plugin-ids.ts`). If that
derived set is empty, OpenClaw keeps the scope empty instead of widening to
every discoverable plugin.

Setup discovery prefers descriptor-owned ids such as `setup.providers` and
`setup.cliBackends` to narrow candidate plugins before falling back to
`setup-api` for plugins that still need setup-time runtime hooks. Provider
setup lists use manifest `providerAuthChoices`, descriptor-derived setup
choices, and install-catalog metadata without loading provider runtime. Explicit
`setup.requiresRuntime: false` is a descriptor-only cutoff; omitted
`requiresRuntime` keeps the legacy setup-api fallback for compatibility. If
more than one discovered plugin claims the same normalized setup provider or
CLI backend id, setup lookup refuses the ambiguous owner instead of relying on
discovery order. When setup runtime executes, registry diagnostics reject
undeclared provider and CLI backend registrations. CLI backend descriptors also
report missing runtime registrations; provider descriptors may stay
metadata-only while the setup module contributes other setup hooks.

### Plugin cache boundary

One `PluginCache` owns plugin facts from first access until Gateway shutdown.
CLI preflight and startup progressively fill the same cache; later access fills
only facts not yet acquired. Its immutable metadata snapshot combines the installed index, manifests, owner maps, and available
discovery facts from every configured agent workspace. Disabled plugins remain
in the inventory so later enablement does not require discovery. Conflicting
plugin IDs from different workspace sources remain rejected.

Runtime readers use this `PluginMetadataSnapshot`, a derived `PluginLookUpTable`,
or an explicit manifest registry. Plugin scopes are in-memory projections;
config changes, account changes, and run workspace changes must not trigger
filesystem scanning, `stat`/`realpath` freshness polling, manifest rereads, or
hashing. Activation and runtime service generations can change while their
package metadata stays fixed. Account health and authentication state are not
part of the immutable package inventory.

The same cache generation prepares installed-index scope lookups, compiled model
matching patterns, parsed install-record projections, and manifest fingerprints
once per immutable index. Mutable management indexes remain uncached. Lookup
methods and install-record results remain caller-owned; enablement and trust are
evaluated from the current operation's policy rather than stored in these facts.

Outside a retained generation, reusing a loaded plugin requires the
selected ID, origin, root, entry point, and artifact-selection inputs to agree.
The loader records source/build selection and any executed setup entry on the loaded owner. Explicit manifest
and discovery source selections, including admitted sidecars, also participate in the loader cache key. Raw
discovery additionally needs matching load identity before active reuse because
its manifest winners have not been established. Retained generations remain
authoritative, including empty selections. Source/build views may share an owner
only when the loader resolves them to the same execution root and entry under
the retained preference. Path names or matching
entry stems alone do not establish ownership. Runtime reuse and loading share
the existing lifecycle-owned artifact facts and final execution step, including
executed setup entries. Discovery and artifact identity retain their selected paths.

Bounded loaded-owner lookups retain the owner's artifact policy when no preference
is specified. An explicit preference is checked; exact loader requests apply the
full cache identity and cold-load defaults.

Provider lookup uses an explicit caller workspace first, then the workspace
recorded by its metadata snapshot, including an explicitly shared-root scope.
Only narrowed metadata views without a workspace field inherit the active
workspace. The registry's existing load context retains its workspace so a request or active
registry from another workspace cannot replace a prepared selection.

Provider hooks share the canonical provider registry selection. Declared providers
reserve their names, while provider-triggered helpers still activate beside them.
Required load owners and eligible hook receivers are captured separately in that
selection. Declared provider owners need matching physical records and provider
registrations before reuse; activation-only helpers may have no provider rows,
but need a successfully completed runtime registration pass. A setup-only pass
cannot prove their runtime contributions are complete. References without a
static owner select only their matching runtime aliases within the requested scope.
Loaded aliases can identify owners to reload, but only the selected registry's
current registrations determine alias receivers.
Loaded-only failover inspection never discovers or activates plugins. When it uses
registry-owned metadata, the caller's discovery and policy inputs must match the
recorded fingerprint. The loader captures normalized registration inputs, including
paired source config, once; later metadata updates preserve that record. Ordinary
lookups reuse callbacks only when those inputs match; retained generations stay
authoritative. Model-reference parsing reads the same declared-owner facts
from the registry or retained request scope, so a failed declared provider cannot
be replaced by another provider's hook alias.

Provider auth aliases are normalized and indexed with the snapshot. Lookups
select among those prepared candidates using the current workspace trust config;
they do not cache trust decisions or credentials. Callers supplying a partial
manifest view keep fresh per-call projection rather than sharing mutable metadata.

Explicit install, update, registry refresh, and doctor operations use isolated
generations of the same cache type, acquired after their lifecycle lease. They may inspect changed files and rebuild the persisted
installed index, but cannot clear or replace the running Gateway's inventory.
The new inventory takes effect after restart. The `plugins.refresh` RPC reports
`restartRequired: true`; with reload disabled, it leaves the running inventory
in place until a manual restart.

The shared cache owns checked file contents, parsed package and manifest data,
bundle MCP/LSP/settings files, plugin skill paths, discovery paths, installed-index
projections, compiled model policies, SDK aliases, artifact locations, and lazy
module exports. Missing files and artifacts are facts too: they remain
missing until a new generation. Discovery, registry assembly, and index hashing
reuse the same checked bytes rather than reopening a file at each stage.

Actual code imports retain their boundary and file-identity checks before first
execution. Consent checks use a fresh inspection after an awaited approval so
changed artifacts cannot inherit approval for older capabilities. Failed module
evaluation remains retryable; a successful import is shared across consumers.

The CLI invocation owns one operation cache across config reads, output metadata,
command ownership, nested registration, and actions. Standalone registration uses
its caller's active generation. Config validation covers every
workspace; execution uses the original selected workspace snapshot, or shared
roots when no workspace owner is proven. Exact config/source identities and
revision checks fence retained registrars. Preparation closes before Commander
actions, while its cache scope lasts through action completion for late imports.
Changed package files require a new operation; changing activation inputs does
not retire compatible package facts. SDK alias maps are prepared on first alias
or transformer demand under their captured host and permission scope. State
registration uses a light facade that the full runtime later adopts; only the
registry proxy grants store access. Config reads import the writer only when an
actual write begins.

Registered services, hooks, tools, session MCP overlays, generated skill-link
publication, and activation state remain runtime-owned.
An active registry pins its chosen artifact binding so source and built modules
cannot split its registrations. Native ESM module lifetime still follows Node's
module loader. Manifest-derived questions such as "which plugin owns this
provider?" use the metadata snapshot without executing plugin code. The persisted
installed index belongs to management and startup; it is not a freshness signal
for runtime readers.

## Registry model

Loaded plugins do not directly mutate random core globals. They register into a
central plugin registry (`PluginRegistry` in `src/plugins/registry-types.ts`),
which tracks plugin records (identity, source, origin, status, diagnostics)
plus arrays for every capability: tools, legacy hooks and typed hooks,
channels, providers, gateway RPC handlers, HTTP routes, CLI registrars,
background services, plugin-owned commands, and dozens more typed provider
families (speech, embeddings, image/video/music generation, web
fetch/search, agent harnesses, session actions, and so on).

Core features then read from that registry instead of talking to plugin
modules directly. This keeps loading one-way:

- plugin module -> registry registration
- core runtime -> registry consumption

That separation matters for maintainability. It means most core surfaces only
need one integration point: "read the registry", not "special-case every
plugin module".
