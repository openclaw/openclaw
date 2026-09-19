---
summary: "Manifest fields for icons, themes, CLI, MCP, Control UI, dashboard, QA, channel, and backup surfaces"
read_when:
  - You are adding plugin branding or compact tool activity artwork
  - Your plugin contributes a CLI command, MCP server, or dashboard widget
  - You are shipping native Control UI or a QA runner
  - Your plugin contributes a theme to the shared appearance catalog
  - You need backups or transcripts to know about plugin-owned data
title: "Manifest host surface fields"
sidebarTitle: "Host surface fields"
---

Manifest fields that contribute a concrete host surface: an icon, a command, a server, a panel, a widget, a runner, a channel, or a backup resource. Part of the [Plugin manifest](/plugins/manifest) reference; the [top-level field reference](/plugins/manifest#top-level-field-reference) lists every field.

## Plugin icon

Place the portable plugin icon at `assets/icon.png`, relative to the plugin root. No manifest
field is required. Use a square PNG that remains recognizable at 16 px; 512×512 is recommended.
Missing, unreadable, or invalid icons are ignored and do not invalidate the plugin.

This is the plugin's identity artwork for catalogs, settings, channel setup, and
installation cards. Compact tool calls use separate
[inline activity icons](#inline-activity-icons), so improving a chat glyph does
not change the plugin's branding elsewhere.

OpenClaw adopts this fixed package path as its icon convention, matching the path proposed in
Agent Plugins spec proposal [agent-plugins-spec#66](https://github.com/agentplugins/agent-plugins-spec/pull/66). OpenClaw itself implements Agent Plugins 1.0.0. Other Agent Plugins
consumers may not discover it unless that proposal is adopted. The fixed path keeps packages
portable and inspectable, avoids manifest path indirection and precedence rules, and lets OpenClaw
render the icon without a runtime network request. Top-level plugin-branding icon URLs are not
loaded; provider-auth artwork remains server-owned catalog metadata.

Prefer top-level `sessionRouteStateOwners` for static doctor ownership. The
older `doctorContract.sessionRouteStateOwners: true` declaration plus a
`sessionRouteStateOwners` export from `doctor-contract-api` remains supported
for external plugins, but is deprecated. When the manifest field is present,
OpenClaw uses it without loading the doctor-contract module. Removal plan:
remove the module fallback in OpenClaw 2027.1 after the external-plugin
migration window.

Set `doctorContract.configRepair: true` when the doctor-contract module exports
non-empty `legacyConfigRules`, a `normalizeCompatibilityConfig` function, or
both. One declaration covers the complete config-repair artifact.

When Doctor renames saved credentials, it updates exact `authProfileId` and
`defaultAuthProfileId` references inside plugin config and channel config. This
preserves the shipped `authProfileId` migration and also covers defaults such as
LLM Task's `defaultAuthProfileId`, including older installed plugins. Reference
lookup trims surrounding whitespace, as the credential reader does. Unmapped
values and literal strings elsewhere remain unchanged. Plugins do not need to
implement the host's credential rename in their compatibility callbacks.

Bundled plugins declare each state migration in execution order so Doctor can
plan its owner and receipt without loading plugin code:

```json
{
  "doctorContract": {
    "stateMigrations": [
      { "id": "legacy-cache-to-state" },
      { "id": "session-owner-repair", "doctorOnly": true, "phase": "after-session-repair" }
    ]
  }
}
```

The array must match the migration IDs, order, `doctorOnly` flags, and phases
exported by the doctor-contract module. The older value `true` still declares
the dynamic module. Installed external plugin manifests remain outside the
copied-state and candidate content identity, including when they use the
descriptor array. Candidate validation must bind those artifacts separately.
Until then, Doctor records an explicit planning refusal instead of treating an
installed manifest as write authority.

A state migration returns `changes` and `warnings`, with optional `notices`. Warnings refuse later
Doctor repairs by default. A migration may return `warningDisposition: "recoverable"` only when every
warning is advisory and required state remains safe for later repairs. Doctor preserves those warnings
in its receipts and continues. Detection errors, thrown failures, and unclassified warnings from another
migration still refuse the combined step.

For `definePluginDoctorMigrationFromPlans`, a `plugin-state-import` plan may set
`cleanupWarningDisposition: "recoverable"` when its retired source is an unused,
rebuildable artifact. This applies only to cleanup failures after import succeeds.
Read, import, and verification failures still refuse the migration. Every plan
consuming a shared source must opt in before its cleanup failures become advisory.

The Codex plugin sets `doctorHealthChecks: true` when its public API exports
health-check registration. Doctor checks the selected plugin's trust before
loading this surface. Older installed versions without the declaration skip
Codex health registration without preventing other checks; a declared but
missing or broken API remains an error. This does not grant plugin capabilities
or replace upgrade consent.

Channel plugins maintained in the OpenClaw source tree also expose these config
exports through a pure `config-doctor-api.ts` entrypoint. The core package retains
that entrypoint alongside its channel schemas when the plugin runtime is
distributed separately. This lets `doctor --fix` migrate older configuration
before plugin installation or capability consent. An installed plugin's doctor
contract remains authoritative; retained entrypoints do not expose state
migrations, install plugins, or grant capabilities.

## Inline activity icons

Place a monochrome SVG at `assets/activity.svg` for the compact icon beside the
plugin's tool calls and collapsed tool results. No manifest field is required.
Design it to remain clear at 16 px with a transparent background. The Control UI
renders its shape in the activity row's text color, including dark mode; source
colors do not become branding colors in the row.

Use `assets/activity/<tool-name>.svg` only when an individual tool needs a
different shape. The filename must exactly match that tool's `id` from
`tools.effective`, including case. For example, a tool with ID `calendar_search`
can ship:

```text
assets/
  icon.png
  activity.svg
  activity/
    calendar_search.svg
```

The tool ID must be at most 128 ASCII characters, start with a letter, digit, or
underscore, and contain only letters, digits, underscores, hyphens, or periods.
Keep the override directory to at most 128 entries; larger directories are
ignored as a whole. The default activity icon covers other tool IDs, including
integrations whose routing adds prefixes to tool names. These files supply presentation only; they do not
register tools or change tool ownership.

Keep each SVG file within 32 KiB. Use simple SVG geometry: `path`, `circle`,
`ellipse`, `line`, `polygon`, `polyline`, and `rect`, optionally inside `g`. The SVG can contain at most four
elements including the root, 8 KiB of combined path and point data, and 1,024
path commands. Give the root a `viewBox` with positive width and height, or
positive numeric `width` and `height`, each at most 4,096. Scripts, stylesheets, event handlers,
external references, embedded images, and filters are not supported. For
example:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M5 5h14v14H5zM8 2v6m8-6v6M5 10h14"/>
</svg>
```

OpenClaw validates the SVG and rasterizes it before using it as an activity
mask; it never inserts package SVG markup into the chat DOM. Missing or invalid
artwork falls back to the existing tool glyph, without showing the packaged
brand image. The plugin remains usable.

Include both `assets/activity.svg` and `assets/activity/*.svg` in the published
package's `files` list when used. OpenClaw's bundled metadata copier and plugin
runtime package builder include these paths automatically. Asset discovery
uses the Gateway's prepared plugin metadata; restart or explicitly reload the
plugin after changing its artwork.

## Themes

Declare portable themes in `openclaw.plugin.json` to make them available in
Settings → Appearance and the agent's [theme tool](/tools/theme). The same
catalog serves both surfaces. Theme discovery reads static JSON and does not
execute plugin code or require the Custom plugin UI Labs setting.

```json
{
  "id": "starship",
  "configSchema": { "type": "object", "additionalProperties": false },
  "themes": [
    {
      "id": "xenovessel",
      "name": "Xenovessel",
      "description": "Near-black indigo, acid lime, and alien cyan with monospace text.",
      "source": "themes/xenovessel.json"
    }
  ]
}
```

The catalog ID is `starship/xenovessel`. It preserves the plugin's canonical ID,
including case, scoped IDs such as `@scope/starship`, and multi-entry IDs such as
`pack/one`; their theme IDs are `@scope/starship/xenovessel` and
`pack/one/xenovessel`. The complete catalog ID is limited to 256 characters.
Each plugin can declare up to 32 themes.
Local IDs must start with a lowercase letter or digit, contain only lowercase
letters, digits, underscores, or hyphens, and be at most 64 characters. The
`user/` namespace belongs to personally imported themes.

`source` is a relative `.json` path inside the plugin root; include it in the
published package's `files` list. Absolute paths, traversal, and symlinks escaping
the root are rejected. Each source file can contain at most 16 KiB including
formatting whitespace. Its normalized definition must fit in 4096 UTF-8 bytes.

The JSON file contains `name`, `description`, and at least one of `light` or
`dark`; its name and description must match the manifest. Names are limited to
80 characters and descriptions to 320. Each present mode supplies all semantic
colors from the [theme definition example](/tools/theme#create-and-apply-a-personal-theme),
plus optional `font-sans` and `font-mono` font-family lists. Individual values are
limited to 120 characters. Supported colors are hex, `rgb()`, `rgba()`, `hsl()`,
`hsla()`, `lab()`, `lch()`, `oklab()`, `oklch()`, `color()`, `black`, `white`, and
`transparent`. CSS declarations, URLs, and references to other CSS variables are
not theme data. An invalid definition is omitted from the catalog with a plugin
diagnostic; other plugin capabilities remain available.

Only enabled plugins contribute themes. OpenClaw retains validated definitions
with the current plugin inventory. After editing a source file or manifest, run
`openclaw plugins reload starship` or choose **Reload** in the plugin's Lifecycle
settings. Reload publishes the new palette and refreshes connected clients
without restarting the Gateway. No filesystem polling is needed. Disabling or
removing the plugin removes its themes from the catalog; the selected theme can
then fall back as described in [Plugin themes and hot reload](/tools/theme#plugin-themes-and-hot-reload).

## Transcript sources reference

`transcriptSources` maps provider IDs to static setup descriptors. Each key must
also appear in this plugin's `contracts.transcriptSourceProviders`; descriptors
for undeclared IDs are ignored. Names and setup controls are available from the
prepared manifest snapshot without importing provider runtime.

```json
{
  "contracts": { "transcriptSourceProviders": ["captions"] },
  "transcriptSources": {
    "captions": {
      "name": "Captions",
      "autoStart": { "accountId": "optional", "meetingUrl": "required" }
    }
  }
}
```

`name` is an optional display name. `autoStart` advertises setup controls to
Gateway clients through `transcripts.status`. Its only keys are `accountId`,
`guildId`, `channelId`, and `meetingUrl`; each value must be `"required"` or
`"optional"`. An explicit empty object supports setup without locator controls.
Omit `autoStart` for sources that only attach to an already-active meeting bot.
Malformed objects, unknown locator keys, or invalid modes do not advertise
partial setup. Title and custom session ID remain existing configuration fields, not locator
descriptor keys.

Setup requires an enabled plugin. Runtime capabilities remain observed facts:
an absent `canStart` does not hide the manifest descriptor, while an observed
`canStart: false` prevents new setup. The descriptor does not change acceptance
of existing `transcripts.autoStart` config or provider start semantics. Existing
source edits preserve configured fields when metadata is unavailable.

## backupResources reference

Use `backupResources` to declare plugin-owned durable data that backups must
include, or generated data that OpenClaw can safely omit and regenerate after
restore. The backup planner reads this metadata without loading plugin runtime
or modifying plugin files. Only effectively activated, loadable plugins
contribute resources; disabled or unloadable plugins cannot exclude data.

An `include` declaration also asks OpenClaw to manage SQLite backups for that
resource. SQLite files at or below the declared path receive verified online
snapshots and offline compaction, with their committed write-ahead log (WAL)
content included and sidecars omitted. Creation refuses a declared database
when its required SQLite capabilities are unavailable. Declare every hardlink
alias within these resources so backup can identify its journal owner.

Other plugin SQLite files remain opaque byte copies, including their sidecars,
unless they alias a canonical OpenClaw database. Backup reports each opaque
SQLite file and sidecar in `warnings`; verification and restore preserve its bytes
without applying SQLite validation or compaction. Merely placing a database
under the state or agent directory does not opt it into managed snapshots.
Undeclared SQLite symbolic links that exceed the link-resolution limit (`ELOOP`),
including loops, are skipped with filename warnings. Declared database links still
fail closed if they cannot be captured safely.

```json
{
  "backupResources": [
    {
      "disposition": "include",
      "scope": "state",
      "relativePath": "example-plugin/durable-state"
    },
    {
      "disposition": "regenerable",
      "scope": "agent",
      "relativePath": "example-plugin/generated-cache"
    }
  ]
}
```

Each entry is a closed object with exactly these fields:

| Field          | Required | Type                         | What it means                                                                          |
| -------------- | -------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| `disposition`  | Yes      | `"include" \| "regenerable"` | Protect durable data from exclusion, or identify data that can be omitted and rebuilt. |
| `scope`        | Yes      | `"state" \| "agent"`         | Resolve the resource under the state directory or each configured agent directory.     |
| `relativePath` | Yes      | `string`                     | Strict relative POSIX path contained by the selected scope's authoritative root.       |

Plugin identity and its trusted root come from manifest discovery; resource
entries cannot declare or override an owner. `relativePath` must not be empty
or absolute and must not contain backslashes, NULs, empty path segments, `.`,
`..`, Windows drive or UNC prefixes, URI-like values, or any path that escapes
its selected anchor. Invalid entries are rejected rather than normalized.

The planner deduplicates resources deterministically. A narrower `regenerable`
declaration wins over a broad configured state or agent root. Among plugin
resource declarations, only an explicit nested `include` protects a descendant
and keeps its excluded ancestors traversable. Explicit config, credentials,
workspace, and nested agent paths also remain protected. Omit only data the
plugin can recreate.
`openclaw backup create --only-config` does not inspect plugin backup metadata.

## MCP server reference

`mcpServers` lets a native plugin ship an MCP server, including an MCP App, without requiring operators to duplicate its static process definition in `openclaw.json`:

```json
{
  "mcpServers": {
    "example": {
      "transport": "stdio",
      "command": "node",
      "args": ["./mcp-server.js"]
    }
  }
}
```

OpenClaw includes these servers only while the owning plugin is enabled. Relative `command`, `args`, `cwd`, and `workingDirectory` paths resolve from the plugin root. User configuration remains authoritative: `mcp.servers.<name>` can replace a plugin default or set `enabled: false` to omit it. MCP App rendering and server-tool calls still require the normal MCP Apps setting and effective tool policy; declaring a server does not bypass either boundary.

## controlUi reference

`controlUi` declares a trusted native browser entry and optional stylesheets for
the Control UI. Paths are relative to the plugin root and must name compiled
JavaScript and CSS. Assets follow the Gateway's authentication policy, are
captured as immutable revisions, and refresh only through the explicit UI reload
flow.

User-installed native UI requires **Settings → Labs → Custom plugin UI**
(`gateway.controlUi.experimental.customPlugins`, default `false`). Native UI
from enabled bundled plugins remains available. See
[Enable custom plugin UI](/plugins/feature-plugins#enable-custom-plugin-ui) for
restart and browser reload requirements. This gate does not disable the
plugin's backend APIs or the sandboxed dashboard bindings below.

```json
{
  "controlUi": {
    "entry": "dist/control-ui/<content-hash>/index.js",
    "styles": ["dist/control-ui/<content-hash>/index.css"]
  }
}
```

Use `package.json.openclaw.controlUi` for the source entry and let
`openclaw plugins build` generate this declaration. Native UI executes with the
browser application's trust; it is distinct from the scoped dashboard widget
bindings below. See [Feature plugins](/plugins/feature-plugins) for authoring,
replacements, reload, and activation receipts.

## dashboard reference

`dashboard` lets an enabled plugin expose existing Gateway RPCs to granted dashboard widgets without adding plugin policy to core. Data bindings must name a method the same plugin registers with `operator.read`; action verbs must name a method it registers with `operator.write`. A mismatch rejects the plugin during registration.

```json
{
  "dashboard": {
    "dataBindings": [
      {
        "id": "items.list",
        "method": "example.items.list",
        "description": "List example items."
      }
    ],
    "actionVerbs": [
      {
        "id": "refresh",
        "method": "example.items.refresh",
        "description": "Refresh example items.",
        "paramShape": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "force": { "type": "boolean" }
          }
        }
      }
    ]
  }
}
```

The manifest ids are plugin-local. Widget grants use `<plugin-id>.<id>`, such as `example.items.list` and `example.refresh`. To keep the persisted grant namespace unambiguous, OpenClaw escapes `%` and `.` in the plugin-id segment as `%25` and `%2E`; ordinary plugin ids keep the natural form. `paramShape` is an optional JSON Schema applied to the action params object before OpenClaw invokes the plugin RPC.

## catalog reference

`catalog` provides optional display hints to plugin browsers. Hosts may ignore these hints. They never install or enable the plugin, and they do not change its runtime behavior or trust level.

```json
{
  "catalog": {
    "featured": true,
    "order": 10
  }
}
```

| Field      | Type      | What it means                                                              |
| ---------- | --------- | -------------------------------------------------------------------------- |
| `featured` | `boolean` | Whether catalog surfaces should feature this plugin.                       |
| `order`    | `number`  | Ascending display hint among curated plugins; lower values appear earlier. |

## cliCommands reference

Declare every plugin-owned root command in `cliCommands` so root help and command-owner routing stay metadata-only:

```json
{
  "cliCommands": [
    {
      "name": "example",
      "description": "Manage the example integration",
      "hasSubcommands": true
    }
  ]
}
```

The manifest row is the canonical help text. Register the same command at runtime with `api.registerCli(..., { descriptors: [...] })`; runtime descriptors may additionally provide `machineOutput`. Nested commands such as `openclaw nodes <feature>` are not root commands and do not belong in `cliCommands`.

## commandAliases reference

Use `commandAliases` when a plugin owns a runtime command name that users may mistakenly put in `plugins.allow` or try to run as a root CLI command. OpenClaw uses this metadata for diagnostics without importing plugin runtime code.

If a plugin fails to load, invoking its declared `runtime-slash` command in chat returns the plugin name, a short failure reason, and recovery guidance (`openclaw doctor` and gateway logs). Unknown commands and commands belonging to intentionally disabled plugins keep their normal handling; manifest ownership alone does not make a command executable.

```json
{
  "commandAliases": [
    {
      "name": "dreaming",
      "kind": "runtime-slash",
      "cliCommand": "memory"
    }
  ]
}
```

| Field        | Required | Type              | What it means                                                           |
| ------------ | -------- | ----------------- | ----------------------------------------------------------------------- |
| `name`       | Yes      | `string`          | Command name that belongs to this plugin.                               |
| `kind`       | No       | `"runtime-slash"` | Marks the alias as a chat slash command rather than a root CLI command. |
| `cliCommand` | No       | `string`          | Related root CLI command to suggest for CLI operations, if one exists.  |

## qaRunners reference

Use `qaRunners` when a plugin contributes one or more transport runners beneath
the shared `openclaw qa` root. Keep this metadata cheap and static; the plugin
runtime still owns actual CLI registration through a lightweight
`qa-runner-api.ts` surface that exports matching `qaRunnerCliRegistrations`. For
plugins using the shipped `runtime-api.ts` contract, that legacy surface remains
accepted through 2026-10-01 while authors migrate. An
optional `adapterFactory` exposes the transport to shared QA scenarios without
changing the registered command's runner.

Module-backed flow scenarios are an adapter-owned execution form. Set
`adapterFactory.supportsModuleFlows` to `true` only when every adapter created
by that factory implements `prepareFlow`; QA planning excludes module flows
from implementations that do not declare support.

```json
{
  "qaRunners": [
    {
      "commandName": "matrix",
      "description": "Run the Docker-backed Matrix live QA lane against a disposable homeserver"
    }
  ]
}
```

| Field         | Required | Type     | What it means                                                      |
| ------------- | -------- | -------- | ------------------------------------------------------------------ |
| `commandName` | Yes      | `string` | Subcommand mounted beneath `openclaw qa`, for example `matrix`.    |
| `description` | No       | `string` | Fallback help text used when the shared host needs a stub command. |

The `adapterFactory` id must match `commandName`. Do not export registrations
for commands absent from the manifest.

## channelAccountKeyPolicies reference

`channelAccountKeyPolicies` declares stored account-key selection rules for channels
listed in the plugin's `channels` array. It is plugin metadata; operators keep their
account config under `channels.<id>.accounts`.

```json
{
  "channels": ["signal"],
  "channelAccountKeyPolicies": {
    "signal": { "canonicalAliasesRequireOwnField": "account" }
  }
}
```

`canonicalAliasesRequireOwnField` is the name of a string field in the account
entry. An alias that matches only after account-id normalization is eligible when
that entry has a nonempty value for this field. Root values do not satisfy it.
Exact stored keys win; existing case-insensitive matches keep their behavior.
Readers and writers use the same selected stored key.

For Signal, `Work Phone` resolves as `work-phone` when it has its own `account`
number. Its settings then apply even if the channel root also has a number.
Without its own number, the previously ignored entry stays ignored and the route
keeps its inherited settings. Doctor preserves that key and reports the required
manual change. Doctor also reports normalized-key collisions and preserves both
entries; an exact `work-phone` key wins at runtime.

Rules for undeclared channels are ignored. Runtime reads use the selected plugin
metadata snapshot; they do not load plugin code to find the rule. See
[account lookup arguments](/plugins/sdk-channel-plugins/setup-and-config#stored-account-key-selection)
for the SDK contract.

## channelConfigs reference

Use `channelConfigs` when a channel plugin needs cheap config metadata before runtime loads. Read-only channel setup/status discovery can use this metadata directly for configured external channels when no setup entry is available, or when `setup.requiresRuntime: false` declares setup runtime unnecessary.

`channelConfigs` is plugin manifest metadata, not a new top-level user config section. Users still configure channel instances under `channels.<channel-id>`. OpenClaw reads manifest metadata to decide which plugin owns that configured channel before plugin runtime code executes.

For a channel plugin, `configSchema` and `channelConfigs` describe different paths:

- `configSchema` validates `plugins.entries.<plugin-id>.config`
- `channelConfigs.<channel-id>.schema` validates `channels.<channel-id>`

Non-bundled plugins that declare `channels[]` should also declare matching `channelConfigs` entries. Without them, OpenClaw can still load the plugin, but cold-path config schema, setup, and Control UI surfaces cannot know the channel-owned option shape or display-only UI hints until plugin runtime executes.

`channelConfigs.<channel-id>.commands.nativeCommandsAutoEnabled` and `nativeSkillsAutoEnabled` can declare static `auto` defaults for command config checks that run before channel runtime loads. Bundled channels can also publish the same defaults through `package.json#openclaw.channel.commands` alongside their other package-owned channel catalog metadata.

```json
{
  "channelConfigs": {
    "matrix": {
      "schema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "homeserverUrl": { "type": "string" }
        }
      },
      "uiHints": {
        "homeserverUrl": {
          "label": "Homeserver URL",
          "placeholder": "https://matrix.example.com"
        }
      },
      "label": "Matrix",
      "description": "Matrix homeserver connection",
      "commands": {
        "nativeCommandsAutoEnabled": true,
        "nativeSkillsAutoEnabled": true
      },
      "preferOver": ["matrix-legacy"]
    }
  }
}
```

Each channel entry can include:

| Field         | Type                     | What it means                                                                                                    |
| ------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `schema`      | `object`                 | JSON Schema for `channels.<id>`. Required for each declared channel config entry.                                |
| `uiHints`     | `Record<string, object>` | Optional labels, placeholders, sensitivity, and display-only presentation hints for that channel config section. |
| `label`       | `string`                 | Channel label merged into picker and inspect surfaces when runtime metadata is not ready.                        |
| `description` | `string`                 | Short channel description for inspect and catalog surfaces.                                                      |
| `commands`    | `object`                 | Static native command and native skill auto-defaults for pre-runtime config checks.                              |
| `preferOver`  | `string[]`               | Legacy or lower-priority plugin ids this channel should outrank in selection surfaces.                           |

### Replacing another channel plugin

Use `preferOver` when your plugin is the preferred owner for a channel id that another plugin can also provide. Common cases are a renamed plugin id, a standalone plugin that supersedes a bundled plugin, or a maintained fork that keeps the same channel id for config compatibility.

```json
{
  "id": "acme-chat",
  "channels": ["chat"],
  "channelConfigs": {
    "chat": {
      "schema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "webhookUrl": { "type": "string" }
        }
      },
      "preferOver": ["chat"]
    }
  }
}
```

When `channels.chat` is configured, OpenClaw considers both the channel id and the preferred plugin id. If the lower-priority plugin was only selected because it is bundled or enabled by default, OpenClaw disables it in the effective runtime config so one plugin owns the channel and its tools. Explicit user selection still wins: if the user explicitly enables both plugins (via `plugins.allow` or a material `plugins.entries` config), OpenClaw preserves that choice and reports duplicate channel/tool diagnostics instead of silently changing the requested plugin set.

Keep `preferOver` scoped to plugin ids that can really provide the same channel. It is not a general priority field and it does not rename user config keys.
