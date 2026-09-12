---
summary: "Manage OpenClaw plugins from the Control UI or CLI"
read_when:
  - You want to browse, configure, enable, disable, or reload plugins in the Control UI
  - You want quick plugin list, install, update, inspect, or uninstall examples
  - You want to choose a plugin install source
  - You want the right reference for publishing plugin packages
title: "Manage plugins"
sidebarTitle: "Manage plugins"
doc-schema-version: 1
---

The Control UI covers discovery, installation, schema-backed configuration,
effective access, enablement, reload, and removal. The CLI adds update,
advanced maintenance, and explicit install-source controls.
For its full command contract, flags, source-selection rules, and edge cases, see
[`openclaw plugins`](/cli/plugins).

Typical workflow: find a package, install it, enable it, then verify the plugin's
runtime registrations. Control UI actions apply to the running Gateway without
restarting it. The CLI also supports npm, git, and local-path installs; see
[Apply changes and inspect](#apply-changes-and-inspect) for those paths.

## Use the Control UI

Open **Plugins** in the Control UI, or use `/plugins` relative to the configured
Control UI base path. For example, a base path of `/openclaw` uses
`/openclaw/plugins`.

**Installed plugins** shows up to 12 installed plugins, prioritizing enabled plugins,
plugins that need setup, and plugins that need attention. Use search to filter
the full inventory or choose **Show all** to browse every installed plugin. Each
card shows the plugin description. Choose a card to open its settings, where
administrators can enable or disable it and read-only operators can inspect it.

A package installed from another ClawHub registry stays manageable under
**Installed plugins**. It does not mark a same-name package in the current
catalog as installed.

Choose a card to open `/settings/plugins/<plugin-id>`.
That routed page uses the plugin's declared schema for configuration, explains
effective access in plain language, and keeps raw capability declarations and
grants under **Advanced**. Its **Lifecycle** section shows source and version
details and lets administrators **Reload** a plugin or uninstall removable plugins
after confirmation.
Open `/settings/plugins` for the searchable installed inventory. Its
**Advanced** tab owns global plugin loading policy, allow and deny lists, load
paths, and capability slots.

Included plugins do not need a package install. Workboard, for example, is
included with OpenClaw and disabled by default. Bundled plugins can be disabled
or reloaded but not removed.

Inventory, configuration, and access inspection require `operator.read`.
Configuration, enable, disable, reload, install, and uninstall changes require `operator.admin`.
Enabling an installed plugin as an
administrator also records that explicit trust by adding the selected plugin to
an existing restrictive `plugins.allow` list. An explicit `plugins.deny` entry
remains authoritative and must be removed before enabling the plugin.

Install, enable, disable, remove, and reload actions wait for the running Gateway to
apply the change. The page and plugin-provided tabs refresh on the existing
connection. If application fails, the error distinguishes a rejected replacement
from a change that was published before a later runtime failure.
An install can remain saved even if its runtime fails to start. The page refreshes
that installed entry and keeps the failure visible. Fix the reported problem, then
choose **Reload** in its **Lifecycle** settings or run `openclaw plugins reload <plugin-id>`; repeating
installation is unnecessary.

**Reload** refreshes the backend plugin and its package entries while preserving
enablement and the current browser connection. Discovered plugins selected through
`plugins.load.paths` and bundled plugins use the same action. Changed declared
capabilities may require review before it proceeds. The success message reports the
applied Gateway generation; a failure keeps its reported application state and
phase visible. Reload does not rebuild compiled bundled code; see
[CLI reload](/cli/plugins#reload) for that boundary. The separate **Reload plugin UI**
action only refreshes browser UI modules.

Administrators can reload with externally managed or Nix config when no new
capability consent needs to be recorded. Config and installation changes stay unavailable. If a
reload requires new capability consent, manage that acceptance through the
deployment owner before retrying.

The Control UI does not install from arbitrary npm, git, or local-path sources,
or update plugin packages. Use the CLI workflows below for those operations.

## List and search plugins

```bash
openclaw plugins list
openclaw plugins list --enabled
openclaw plugins list --verbose
openclaw plugins list --json
openclaw plugins search "calendar"
```

`--json` for scripts:

```bash
openclaw plugins list --json \
  | jq '.plugins[] | {id, enabled, format, source, dependencyStatus}'
```

`plugins list` is a cold inventory check: what OpenClaw can discover from
config, manifests, and the persisted plugin registry. It does not prove an
already-running Gateway imported the plugin runtime. JSON output includes
registry diagnostics and each plugin's `dependencyStatus` (whether declared
`dependencies`/`optionalDependencies` resolve on disk).

`plugins search` queries ClawHub for installable plugin packages and prints
an install hint (`openclaw plugins install clawhub:<package>`) per result.

## Enable and disable plugins

```bash
openclaw plugins enable <plugin-id>
openclaw plugins disable <plugin-id>
```

Toggles a plugin's config entry without touching installed files. Some
bundled plugins (bundled model/speech providers, the bundled browser plugin)
are enabled by default; others require `enable` after install.

## Capability consent

OpenClaw asks you to review a third-party plugin's declared capabilities before
installing or enabling it. The consent screen identifies the plugin, its
version and source, artifact integrity, and available trust information. It
also lists declared channels, providers, tools, hooks, MCP servers, CLI
commands and backends, skills, and dangerous configuration flags, along with
the operator grants that apply to hooks, model access, and subagents.

Outside AI onboarding, bundled plugins and verified first-party plugins from OpenClaw's official
catalog do not require this capability review during install, enable, update,
or Doctor repair. For separately installed first-party plugins, OpenClaw checks
the actual package identity against its catalog and verified npm source record
or official-channel record from `https://clawhub.ai`. A matching plugin id or
package name alone is insufficient: local copies, archives, git installs,
custom ClawHub registries, and conflicting source records still require review.
This exemption does not grant OAuth access, operating-system permissions, or
runtime tool approvals, and does not create an operator acceptance record.

AI onboarding also requests a review when you choose an installable provider or
required runtime from the official catalog. After you accept, setup continues
with that provider.

The review token hashes the exact declared capability surface, not the plugin's
executable files. Acceptance separately records installer-provided artifact
integrity when available. Re-enabling an installed plugin reuses acceptance
when its declared surface and recorded integrity are unchanged. Updates of
enabled plugins require fresh consent when the new artifact declares additional
capabilities; unchanged or narrower
surfaces can refresh an existing valid acceptance. Updating a disabled
plugin preserves disablement and defers any required consent until enablement.
Reinstalling through `plugins install` also preserves an authored `enabled: false`,
but requires consent before committing the install when no valid acceptance can
be reused. Run `openclaw plugins enable <plugin-id>` to activate it afterward.

Already-enabled third-party legacy installations remain usable without an initial review;
disabling and re-enabling them requires consent. Setup rechecks consent when
saving its final config, so a plugin update during login cannot activate a
replacement with unaccepted capabilities.

Declining an update's capability review leaves the previous plugin enabled
and unchanged. Repairing a missing or damaged artifact requires a fresh review;
OpenClaw cannot carry acceptance forward from an artifact it cannot verify.

Carrying an earlier acceptance forward requires the install record to pin
artifact integrity, which registry and ClawHub installs provide. Sources
without recorded integrity — notably local paths — cannot prove the new bytes
are the artifact you approved before, so they ask for consent on every install
rather than inheriting it.

Interactive CLI commands, onboarding, and provider, search, or channel setup
prompt when consent is required, including automatic installs of required
runtime plugins. Noninteractive or silent setup cannot approve new capabilities.
Review and preinstall or enable the plugin with `--accept-capabilities`, then
retry setup. Noninteractive plugin install, update, and enable commands also
require the explicit flag when consent is needed:

```bash
openclaw plugins install clawhub:<package> --accept-capabilities
openclaw plugins update <plugin-id> --accept-capabilities
openclaw plugins enable <plugin-id> --accept-capabilities
```

Doctor uses the same source checks and review before installing or adopting a replacement plugin.
`doctor --fix` and `--yes` do not approve capabilities automatically. For
noninteractive repair, review and install the plugin with the explicit flag
above, then rerun doctor.

Chat installs and enablement use the same capability consent. When consent is
required, review the capabilities in the reply, then rerun the same command
with `--accept-capabilities`:

```text
/plugins install clawhub:<package> --accept-capabilities
/plugins install npm:<package> --force --accept-capabilities
/plugins enable <plugin-id> --accept-capabilities
```

Plugins discovered directly
in a workspace or through `plugins.load.paths`, without a managed install
record, cannot persist capability acceptance. Their details in the Control UI
still show declared capabilities.

`openclaw plugins install --link <path>` creates a managed install record and
requires capability consent even though it loads the plugin from its source
directory. It is not the same as adding a bare `plugins.load.paths` entry.

## Install plugins

```bash
# Search ClawHub for plugin packages.
openclaw plugins search "calendar"

# Install from ClawHub.
openclaw plugins install clawhub:<package>
openclaw plugins install clawhub:<package>@1.2.3
openclaw plugins install clawhub:<package>@beta

# Install from npm.
openclaw plugins install npm:<package>
openclaw plugins install npm:@scope/openclaw-plugin@1.2.3
openclaw plugins install npm:@openclaw/codex

# Install from a local npm-pack artifact.
openclaw plugins install npm-pack:<path.tgz>

# Install from git or a local development checkout.
openclaw plugins install git:github.com/acme/openclaw-plugin@v1.0.0
openclaw plugins install ./my-plugin
openclaw plugins install --link ./my-plugin
```

Bare package specs install from npm, unless the name matches a bundled or
official plugin id, in which case OpenClaw uses
that local/official copy instead. Use `clawhub:`, `npm:`, `git:`, or
`npm-pack:` for deterministic source selection. OpenClaw's bundled and official
catalog packages are trusted alongside ClawHub packages. New arbitrary npm,
git, local path/archive, `npm-pack:`, or marketplace sources require
`--force` in noninteractive installs after you review
and trust the source.

`--force` confirms a non-ClawHub source without prompting and overwrites an
existing install target when needed. For routine upgrades of a tracked npm,
ClawHub, or hook-pack install, use `openclaw plugins update` instead. With
`--link`, `--force` only confirms the source; the linked directory is not
copied or overwritten.

If a newly installed plugin requires configuration that is not present yet,
OpenClaw records the install but leaves the plugin disabled. Configure
`plugins.entries.<id>.config`, then run `openclaw plugins enable <id>`. If an
existing config entry is present but invalid, install fails without rewriting it.

A plugin package can expose multiple child entries. Installation tracks that
package once, enables each ready child entry, and preserves any child that you
explicitly disabled. Runtime policy remains child-addressable through
`plugins.entries.<child-id>`, allow/deny lists, channel config, exact child load
paths, and the `memory` and `contextEngine` slots.

<a id="restart-and-inspect" />

## Apply changes and inspect

Control UI actions and the Gateway plugin-management RPCs apply plugin changes
without restarting the Gateway. Ordinary CLI enable, disable, and uninstall
commands use the running Gateway when available; updates refresh it after the
local package operation finishes. Without a running Gateway, those commands
update the local installation for its next startup.

CLI installation from npm, git, archives, and local paths still uses the local
installer and requests a Gateway restart. Use Control UI installation for
official or ClawHub packages when you need synchronous application without a
restart. If automatic restart is disabled, restart before checking the locally
installed runtime surfaces:

```bash
openclaw gateway restart
openclaw plugins inspect <plugin-id> --runtime --json
```

The Gateway reuses its current plugin inventory until startup or an explicit
owner update. Run `openclaw plugins reload <plugin-id>` after source or manifest
edits. For API clients, `plugins.reload` takes `plugins: [{ pluginId }]` to reload
one installed plugin, or multiple targets in the same request, and
`plugins.refresh` refreshes the inventory.
Both wait for runtime application and return `restartRequired: false` with a
generation receipt. Explicit actions also work with `gateway.reload.mode: "off"`.
See [Plugin management RPCs](/gateway/protocol).

Cleanup is best effort: disabling removes the plugin's registered capabilities
and attempts to stop its services and cleanup hooks. A successful change can
include warnings about unfinished cleanup. Cached modules, native libraries, or
other process state may remain until the Gateway exits. Restart is a recovery
option when those leftovers cause problems.

`inspect --runtime` loads the plugin module and proves it registered runtime
surfaces (tools, hooks, services, Gateway methods, HTTP routes, plugin-owned
CLI commands). Plain `inspect` and `list` are cold manifest/config/registry
checks only.

## Update plugins

```bash
openclaw plugins update <plugin-id>
openclaw plugins update <npm-package-or-spec>
openclaw plugins update --all
openclaw plugins update <plugin-id> --dry-run
```

Passing a plugin id reuses its tracked install spec: stored dist-tags
(`@beta`) and exact pinned versions carry over to later `update <plugin-id>`
runs. For a multi-entry package, any child id resolves to the one tracked
package install, so all siblings update together. Removed or renamed children
have their stale entries, allow/deny policy, exact load paths, channel config,
and memory/context slot selections reconciled before the new package/index
state commits; retained/new children and unrelated plugins are preserved.

If OpenClaw cannot prove exactly one package owner and a complete child list,
update and uninstall fail closed without changing package files, config, or the
installed index. Run `openclaw plugins registry --refresh`, inspect
`openclaw plugins doctor`, and use `openclaw doctor --fix` for repairable legacy
index state. If the ambiguity remains, reinstall the package before retrying.

`openclaw plugins update --all` is the bulk maintenance path. It preserves
exact version pins and explicit tags, including trusted official OpenClaw
plugin records, because older automatic pins cannot be distinguished from an
operator's intentional pin. When a newer default-line release exists,
OpenClaw reports it and prints the explicit command that replaces the pin.
Floating official records still follow the canonical channel resolver, which
uses both `update.channel` and the installed core version.

For an exact-pinned ClawHub record, deliberately return to the default release
line with the command printed by the updater:

```bash
openclaw plugins install clawhub:<package> --force
```

For npm installs, pass an explicit package spec to switch the tracked
record:

```bash
openclaw plugins update @scope/openclaw-plugin@beta
openclaw plugins update @scope/openclaw-plugin
```

The second command moves a plugin back to the registry's default release
line when it was previously pinned to an exact version or tag.

See [`openclaw plugins`](/cli/plugins#update) for the exact fallback and
pinning rules.

## Uninstall plugins

```bash
openclaw plugins uninstall <plugin-id> --dry-run
openclaw plugins uninstall <plugin-id>
openclaw plugins uninstall <plugin-id> --keep-files
```

Uninstall removes the package's persisted install record and every owned child's
settings from plugin config, allow/deny lists, memory/context slots, exact linked
`plugins.load.paths`, and channel config entries when applicable. It retains only
an exact `enabled: false` marker for each removed child so remaining model,
provider, or channel selections cannot automatically reinstall the package during
startup repair. Reinstalling does not silently re-enable it; enabling the plugin
again replaces the marker. You may address a multi-entry package by any child id;
the preview names the package owner and all siblings that will be removed. The
managed install directory is removed once unless you pass `--keep-files`. With a
running Gateway, ordinary uninstall waits for the package's runtime owners to
stop before removing files and returns after the new inventory is applied.

If an installed Claw references the plugin, preview and uninstall print the
affected Claw package names. Ordinary plugin uninstall can still proceed and
may break those Claws; use `openclaw claws status` to review ownership first.
Removing a Claw releases its plugin reference but retains the process-wide
plugin by default.

In Nix mode (`OPENCLAW_NIX_MODE=1`), plugin install, update, uninstall,
enable, and disable are all disabled; manage those choices in the Nix source
for the install instead.

## Choose a source

| Source      | Use when                                                                    | Example                                                        |
| ----------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| ClawHub     | You want OpenClaw-native discovery, scan summaries, versions, and hints     | `openclaw plugins install clawhub:<package>`                   |
| git         | You want a branch, tag, or commit from a repository                         | `openclaw plugins install git:github.com/<owner>/<repo>@<ref>` |
| local path  | You are developing or testing a plugin on the same machine                  | `openclaw plugins install --link ./my-plugin`                  |
| marketplace | You are installing a Claude-compatible marketplace plugin                   | `openclaw plugins install <plugin> --marketplace <source>`     |
| npm pack    | You are proving a local package artifact through npm install semantics      | `openclaw plugins install npm-pack:<path.tgz>`                 |
| npmjs.com   | You already ship JavaScript packages or need npm dist-tags/private registry | `openclaw plugins install npm:@acme/openclaw-plugin`           |

Managed local path installs must be plugin directories or archives. Put
standalone plugin files in `plugins.load.paths` instead of installing them
with `plugins install`.

## Publish plugins

ClawHub is the primary public discovery surface for OpenClaw plugins. Publish
there when you want users to find plugin metadata, version history, registry
scan results, and install hints before they install.

```bash
npm i -g clawhub
clawhub login
clawhub package publish your-org/your-plugin --dry-run
clawhub package publish your-org/your-plugin
clawhub package publish your-org/your-plugin@v1.0.0
```

Native npm plugins must ship a plugin manifest (`openclaw.plugin.json`) plus
`package.json` metadata before publishing:

```json package.json
{
  "name": "@acme/openclaw-plugin",
  "version": "1.0.0",
  "type": "module",
  "openclaw": {
    "extensions": ["./dist/index.js"]
  }
}
```

```bash
npm publish --access public
openclaw plugins install npm:@acme/openclaw-plugin
openclaw plugins install npm:@acme/openclaw-plugin@beta
openclaw plugins install npm:@acme/openclaw-plugin@1.0.0
```

Use these pages for the full publishing contract instead of treating this
page as the publishing reference:

- [ClawHub publishing](/clawhub/publishing) explains owners, scopes,
  releases, review, package validation, and package transfer.
- [Building plugins](/plugins/building-plugins) shows the full plugin
  package shape (including `openclaw.plugin.json`) and first publish
  workflow.
- [Plugin manifest](/plugins/manifest) defines native plugin manifest
  fields.

If the same package is available on both ClawHub and npm, use the explicit
`clawhub:` or `npm:` prefix to force one source.

## Related

- [Plugins](/tools/plugin) - install, configure, restart, and troubleshoot
- [`openclaw plugins`](/cli/plugins) - full CLI reference
- [Community plugins](/plugins/community) - public discovery and ClawHub publishing
- [ClawHub](/clawhub/cli) - registry CLI operations
- [Building plugins](/plugins/building-plugins) - create a plugin package
- [Plugin manifest](/plugins/manifest) - manifest and package metadata
