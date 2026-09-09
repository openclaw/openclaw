---
summary: "Plugin SDK import subpaths, multi-extension package packs, and channel catalog and install metadata"
read_when:
  - Implementing package packs
  - You are choosing plugin SDK import subpaths for a new plugin
  - You are publishing channel catalog or install metadata
title: "Package packs and import paths"
sidebarTitle: "Packs and import paths"
---

Which SDK subpaths a plugin should import, how a package pack turns extensions
into plugins, and the catalog and install metadata a channel package can
publish. Part of the [Plugin architecture
internals](/plugins/architecture-internals) guide.

## Plugin SDK import paths

Use narrow SDK subpaths instead of the monolithic `openclaw/plugin-sdk` root
barrel when authoring new plugins. Core subpaths:

| Subpath                            | Purpose                                      |
| ---------------------------------- | -------------------------------------------- |
| `openclaw/plugin-sdk/plugin-entry` | Plugin registration primitives               |
| `openclaw/plugin-sdk/channel-core` | Channel entry/build helpers                  |
| `openclaw/plugin-sdk/core`         | Generic shared helpers and umbrella contract |

Channel plugins pick from a family of narrow seams — `channel-setup`,
`setup-runtime`, `setup-tools`, `channel-pairing`,
`channel-contract`, `channel-feedback`, `channel-inbound`, `channel-outbound`,
`command-auth`, `secret-input`, `webhook-ingress`,
`channel-targets`, and `channel-actions`. Approval behavior should consolidate
on one `approvalCapability` contract rather than mixing across unrelated
plugin fields. See [Channel plugins](/plugins/sdk-channel-plugins).

Runtime and config helpers live under matching focused `*-runtime` subpaths
(`approval-runtime`, `agent-runtime`, `lazy-runtime`, `directory-runtime`,
`text-utility-runtime`, `runtime-store`, `system-event-runtime`, `heartbeat-runtime`,
`channel-activity-runtime`, etc.). Prefer `config-contracts`,
`plugin-config-runtime`, `runtime-config-snapshot`, and `config-mutation`
instead of the broad `config-runtime` compatibility barrel.

<Info>
`openclaw/plugin-sdk/channel-lifecycle`, small channel helper facades,
`openclaw/plugin-sdk/config-runtime`, and `openclaw/plugin-sdk/infra-runtime`
are deprecated compatibility shims for older plugins. New code should import
narrower generic primitives instead.
</Info>

Repo-internal entry points (per bundled plugin package root):

- `index.js` — bundled plugin entry
- `api.js` — helper/types barrel
- `runtime-api.js` — runtime-only barrel
- `setup-entry.js` — setup plugin entry

External plugins should only import `openclaw/plugin-sdk/*` subpaths. Never
import another plugin package's `src/*` from core or from another plugin.
Facade-loaded entry points prefer the active runtime config snapshot when one
exists, then fall back to the resolved config file on disk.

Capability-specific subpaths such as `image-generation`, `media-understanding`,
and `speech` exist because bundled plugins use them today. They are not
automatically long-term frozen external contracts — check the relevant SDK
reference page when relying on them.

## Package packs

A plugin directory may include a `package.json` with `openclaw.extensions`:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"],
    "setupEntry": "./src/setup-entry.ts"
  }
}
```

Each entry becomes a plugin. If the pack lists multiple extensions, the plugin
id becomes `<manifestOrPackageName>/<fileBase>` (manifest id wins when
present; otherwise the unscoped `package.json` name).

If your plugin imports npm deps, install them in that directory so
`node_modules` is available (`npm install` / `pnpm install`).

Security guardrail: every `openclaw.extensions` entry must stay inside the plugin
directory after symlink resolution. Entries that escape the package directory are
rejected.

Security note: `openclaw plugins install` installs plugin dependencies with a
project-local `npm install --omit=dev --ignore-scripts` (no lifecycle scripts,
no dev dependencies at runtime), ignoring inherited global npm install settings.
Keep plugin dependency trees "pure JS/TS" and avoid packages that require
`postinstall` builds.

Optional: `openclaw.setupEntry` can point at a lightweight setup-only module.
When OpenClaw needs setup surfaces for a disabled channel plugin, or
when a channel plugin is enabled but still unconfigured, it loads `setupEntry`
instead of the full plugin entry. This keeps startup and setup lighter
when your main plugin entry also wires tools, hooks, or other runtime-only
code.

Bundled channels can also publish setup-only contract-surface helpers that core
can consult before the full channel runtime is loaded. The current setup
promotion surface is:

- `singleAccountKeysToMove`
- `namedAccountPromotionKeys`
- `resolveSingleAccountPromotionTarget(...)`

Core uses that surface when it needs to promote a legacy single-account channel
config into `channels.<id>.accounts.*` without loading the full plugin entry.
Matrix is the current bundled example: it moves only auth/bootstrap keys into a
named promoted account when named accounts already exist, and it can preserve a
configured non-canonical default-account key instead of always creating
`accounts.default`.

Those setup patch adapters keep bundled contract-surface discovery lazy. Import
time stays light; the promotion surface is loaded only on first use instead of
re-entering bundled channel startup on module import.

When setup surfaces include gateway RPC methods, keep them on a
plugin-specific prefix. Core admin namespaces (`config.*`,
`exec.approvals.*`, `wizard.*`, `update.*`) remain reserved and always resolve
to `operator.admin`, even if a plugin requests a narrower scope.

### Channel catalog metadata

Channel plugins can advertise setup/discovery metadata via `openclaw.channel` and
install hints via `openclaw.install`. This keeps the core catalog data-free.

Example:

```json
{
  "name": "@openclaw/nextcloud-talk",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "nextcloud-talk",
      "label": "Nextcloud Talk",
      "selectionLabel": "Nextcloud Talk (self-hosted)",
      "docsPath": "/channels/nextcloud-talk",
      "docsLabel": "nextcloud-talk",
      "blurb": "Self-hosted chat via Nextcloud Talk webhook bots.",
      "order": 65,
      "aliases": ["nc-talk", "nc"]
    },
    "install": {
      "npmSpec": "@openclaw/nextcloud-talk",
      "localPath": "<bundled-plugin-local-path>",
      "defaultChoice": "npm"
    }
  }
}
```

Useful `openclaw.channel` fields beyond the minimal example:

- `detailLabel`: secondary label for richer catalog/status surfaces
- `docsLabel`: override link text for the docs link
- `preferOver`: lower-priority plugin/channel ids this catalog entry should outrank
- `selectionDocsPrefix`, `selectionDocsOmitLabel`, `selectionExtras`: selection-surface copy controls
- `markdownCapable`: marks the channel as markdown-capable for outbound formatting decisions
- `exposure.configured`: hide the channel from configured-channel listing surfaces when set to `false`
- `exposure.setup`: hide the channel from interactive setup/configure pickers when set to `false`
- `exposure.docs`: mark the channel as internal/private for docs navigation surfaces
- `quickstartAllowFrom`: opt the channel into the standard quickstart `allowFrom` flow
- `forceAccountBinding`: require explicit account binding even when only one account exists
- `preferSessionLookupForAnnounceTarget`: prefer session lookup when resolving announce targets

OpenClaw can also merge **external channel catalogs** (for example, an MPM
registry export). Drop a JSON file at one of:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

Or point `OPENCLAW_PLUGIN_CATALOG_PATHS` (or `OPENCLAW_MPM_CATALOG_PATHS`) at
one or more JSON files (comma/semicolon/`PATH`-delimited). Each file should
contain `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`. The parser also accepts `"packages"` or `"plugins"` as legacy aliases for the `"entries"` key.

Generated channel catalog entries and provider install catalog entries expose
normalized install-source facts next to the raw `openclaw.install` block. The
normalized facts identify whether the npm spec is an exact version or floating
selector, whether expected integrity metadata is present, and whether a local
source path is also available. When the catalog/package identity is known, the
normalized facts warn if the parsed npm package name drifts from that identity.
They also warn when `defaultChoice` is invalid or points at a source that is
not available, and when npm integrity metadata is present without a valid npm
source. Consumers should treat `installSource` as an additive optional field so
hand-built entries and catalog shims do not have to synthesize it.
This lets onboarding and diagnostics explain source-plane state without
importing plugin runtime.

Official external npm entries should prefer an exact `npmSpec` plus
`expectedIntegrity`. Bare package names and dist-tags still work for
compatibility, but they surface source-plane warnings so the catalog can move
toward pinned, integrity-checked installs without breaking existing plugins.
When an official package is renamed, the catalog entry may declare
`legacyNpmPackageNames` with the former package names. Trusted update rewrites
matching npm records to the current `npmSpec`, and migrates a catalog lookup
alias such as a channel id to the canonical plugin id. Duplicate alias+canonical
records drop only when the canonical install is also trusted official.
`legacyPluginIds` remains the contract for plugin-id cutovers that are not lookup
aliases.
When onboarding installs from a local catalog path, it records a managed plugin
plugin index entry with `source: "path"` and a workspace-relative
`sourcePath` when possible. The absolute operational load path stays in
`plugins.load.paths`; the install record avoids duplicating local workstation
paths into long-lived config. This keeps local development installs visible to
source-plane diagnostics without adding a second raw filesystem-path disclosure
surface. The persisted `config_machine_state` value under
`plugins.installedIndex` is the install source of truth and can be refreshed
without loading plugin runtime modules. Its `installRecords` map is durable
even when a plugin manifest is missing or invalid; its `plugins` payload is a
rebuildable manifest view.
