---
summary: "How OpenClaw installs plugin packages and resolves plugin dependencies"
read_when:
  - You are debugging plugin package installs
  - You are changing plugin startup, doctor, or package-manager install behavior
  - You are maintaining packaged OpenClaw installs or bundled plugin manifests
title: "Plugin dependency resolution"
sidebarTitle: "Dependencies"
doc-schema-version: 1
---

OpenClaw keeps plugin dependency work at install, update, uninstall, and doctor
repair time. Gateway startup, config reload, cold inspection, and runtime
verification do not run package managers or repair dependency trees.

Use this page when you need the install-time lifecycle. For quick install
commands, see [Manage plugins](/plugins/manage-plugins). For full CLI flags,
see [`openclaw plugins`](/cli/plugins).

## Responsibility split

Plugin packages own their dependency graph:

- runtime dependencies live in the plugin package `dependencies` or
  `optionalDependencies`
- SDK/core imports are peer or supplied OpenClaw imports
- local development plugins bring their own already-installed dependencies
- npm, git, ClawHub, and npm-pack plugins are installed into OpenClaw-owned
  package roots

OpenClaw owns the lifecycle around that package:

- resolve the requested source
- install or update the package when explicitly requested
- validate package metadata and plugin manifests
- record durable install metadata
- refresh the cold plugin registry
- load the plugin entrypoint during the appropriate runtime path
- fail with an actionable error when dependencies or runtime files are missing

## Install roots

OpenClaw uses stable per-source roots:

- npm packages install under `~/.openclaw/npm`
- git packages clone under `~/.openclaw/git`
- local path/archive installs copy into or link from the plugin extensions root
- marketplace installs copy the selected marketplace entry into the plugin
  extensions root

npm installs run in the npm root with:

```bash
cd ~/.openclaw/npm
npm install --omit=dev --omit=peer --legacy-peer-deps --ignore-scripts --no-audit --no-fund
```

`openclaw plugins install npm-pack:<path.tgz>` uses that same managed npm root
for a local npm-pack tarball. OpenClaw reads the tarball's npm metadata, adds it
to the managed root as a copied `file:` dependency, runs the normal npm install,
and verifies installed lockfile metadata before trusting the plugin.

npm may hoist transitive dependencies to `~/.openclaw/npm/node_modules` beside
the plugin package. OpenClaw scans the managed npm root before trusting the
install and uses npm to remove npm-managed packages during uninstall, so hoisted
runtime dependencies stay inside the managed cleanup boundary.

Plugins that import `openclaw/plugin-sdk/*` declare `openclaw` as a peer
dependency. OpenClaw does not let npm install a separate registry copy of the
host package into the managed root, because stale host packages can affect npm
peer resolution during later plugin installs. Managed npm installs skip npm peer
resolution/materialization for the shared root and OpenClaw reasserts
plugin-local `node_modules/openclaw` links for installed packages that declare
the host peer after install, update, or uninstall.

git installs clone or refresh the repository, check out the requested ref when
present, then run:

```bash
npm install --omit=dev --ignore-scripts --no-audit --no-fund
```

The installed plugin then loads from that package directory, so package-local
and parent `node_modules` resolution works like a normal Node package.

## Source resolution

OpenClaw accepts explicit install locators:

| Locator                  | Meaning                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `clawhub:<package>`      | Resolve from ClawHub only                                      |
| `npm:<package>`          | Resolve from npm only                                          |
| `npm-pack:<path.tgz>`    | Install a local npm-pack tarball through npm install semantics |
| `git:<repo>@<ref>`       | Clone a git repository and optionally check out a ref          |
| `--marketplace <source>` | Install a compatible marketplace plugin entry                  |
| local path or archive    | Copy or link a local plugin source/archive                     |

Bare specs keep compatibility behavior:

- a bare bundled plugin id resolves to the bundled plugin source
- a bare official external plugin id resolves through the official external
  package catalog
- other ordinary bare package specs install through npm during the launch
  cutover

Use an explicit locator when source choice is part of the proof or production
runbook.

## Package entrypoints

Native plugin npm packages must declare `openclaw.extensions` in
`package.json`. Each entry must stay inside the package directory and resolve to
a readable runtime file, or to a TypeScript source file with an inferred built
JavaScript peer such as `src/index.ts` to `dist/index.js`.

Packaged installs must ship that JavaScript runtime output. The TypeScript
source fallback is for source checkouts and local development paths, not for npm
packages installed into OpenClaw's managed plugin root.

Use `openclaw.runtimeExtensions` when published runtime files do not live at the
same paths as the source entries. When present, `runtimeExtensions` must contain
exactly one entry for every `extensions` entry. Mismatched lists fail install and
plugin discovery rather than silently falling back to source paths. If you also
publish `openclaw.setupEntry`, use `openclaw.runtimeSetupEntry` for its built
JavaScript peer; that file is required when declared.

```json
{
  "name": "@acme/openclaw-plugin",
  "openclaw": {
    "extensions": ["./src/index.ts"],
    "runtimeExtensions": ["./dist/index.js"]
  }
}
```

If a managed package warning says it `requires compiled runtime output for
TypeScript entry ...`, the package was published without the JavaScript files
OpenClaw needs at runtime. Update or reinstall the plugin after the publisher
republishes compiled JavaScript, or disable/uninstall that plugin until a fixed
package is available.

## Install records and registry state

OpenClaw stores durable plugin install metadata in `plugins/installs.json` under
the active state directory. The top-level `installRecords` map is the durable
source of install metadata. The `plugins` array is a rebuildable manifest-derived
cold registry cache.

Install, update, uninstall, enable, and disable flows refresh the registry after
changing plugin state. If the registry is missing, stale, or invalid, rebuild
the manifest view from install records, config policy, and package metadata:

```bash
openclaw plugins registry --refresh
```

`openclaw plugins list --json` exposes static registry diagnostics and
`dependencyStatus` without importing plugin runtime code or repairing
dependencies.

## Config writes during lifecycle commands

Plugin lifecycle commands update config and install records together when they
need to keep the plugin loadable:

- `plugins install` enables the installed plugin and refreshes the registry.
- If `plugins.allow` is already set, install adds the plugin id to that
  allowlist.
- If the plugin id is present in `plugins.deny`, install removes the stale deny
  entry.
- `plugins uninstall` removes the plugin config entry, install record,
  allow/deny entries, and linked `plugins.load.paths` entries when applicable.
- `plugins enable` and `plugins disable` write config and refresh the registry.

If your `plugins` section is backed by a supported single-file `$include`, these
commands write through to the included file. Unsupported include shapes fail
closed instead of flattening config.

In Nix mode (`OPENCLAW_NIX_MODE=1`), plugin install, update, uninstall, enable,
and disable commands are disabled. Manage plugin choices in the Nix source for
that install.

## Local plugins

Local plugins are developer-controlled directories. OpenClaw does not run
`npm install`, `pnpm install`, or dependency repair for them. If a local plugin
has dependencies, install them in that plugin before loading it.

Use `--link` to add the local path to `plugins.load.paths` without copying it.
`--link` is not supported with `--force`, `git:`, or `--marketplace` installs.

Third-party TypeScript local plugins can use the emergency Jiti path. Packaged
JavaScript plugins and bundled internal plugins load through native
import/require instead of Jiti.

## Startup and reload

Gateway startup and config reload read plugin install records, compute the
entrypoint, and load it. They never install plugin dependencies.

If a dependency is missing at runtime, the plugin fails to load and the error
should point the operator to an explicit fix:

```bash
openclaw plugins update <id>
openclaw plugins install <source>
openclaw doctor --fix
```

Config changes made through `/plugins enable` or `/plugins disable` trigger an
in-process Gateway plugin reload. New agent turns rebuild their tool list from
the refreshed plugin registry. Source-changing operations such as install,
update, and uninstall still require a Gateway restart because already-imported
plugin modules cannot be safely replaced in place.

If config is invalid during install, `plugins install` normally fails closed and
points you at `openclaw doctor --fix`. The install-time recovery exception is a
narrow bundled-plugin path for plugins that opt into
`openclaw.install.allowInvalidConfigRecovery`. During Gateway startup, invalid
plugin config fails closed like any other invalid config.

`openclaw doctor --fix` can quarantine invalid plugin config by disabling the
plugin entry and removing its invalid config payload; the normal config backup
keeps the previous values.

## Bundled plugins

Lightweight and core-critical bundled plugins are shipped as part of OpenClaw.
They should either have no heavy runtime dependency tree or be moved out to a
downloadable package on ClawHub/npm.

For the current generated list of plugins that ship in the core package, install
externally, or stay source-only, see [Plugin inventory](/plugins/plugin-inventory).

Bundled plugin manifests must not request dependency staging. Large or optional
plugin functionality should be packaged as a normal plugin and installed through
the same npm/git/ClawHub path as third-party plugins.

In source checkouts, OpenClaw treats the repository as a pnpm monorepo. After
`pnpm install`, bundled plugins load from `extensions/<id>` so package-local
workspace dependencies are available and edits are picked up directly. Source
checkout development is pnpm-only; plain `npm install` at the repository root is
not a supported way to prepare bundled plugin dependencies.

| Install shape                    | Bundled plugin location               | Dependency owner                                                     |
| -------------------------------- | ------------------------------------- | -------------------------------------------------------------------- |
| `npm install -g openclaw`        | Built runtime tree inside the package | OpenClaw package and explicit plugin install/update/doctor flows     |
| Git checkout plus `pnpm install` | `extensions/<id>` workspace packages  | The pnpm workspace, including each plugin package's own dependencies |
| `openclaw plugins install ...`   | Managed npm/git/ClawHub plugin root   | The plugin install/update flow                                       |

Packaged installs and Docker images normally resolve bundled plugins from the
compiled `dist/extensions` tree. If a bundled plugin source directory is
bind-mounted over the matching packaged source path, OpenClaw treats that
mounted source directory as a bundled source overlay and discovers it before the
packaged `dist/extensions` bundle. Set
`OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS=1` to force packaged dist bundles even
when source overlay mounts are present.

## Legacy cleanup

Older OpenClaw versions generated bundled-plugin dependency roots at startup or
during doctor repair. Current doctor cleanup removes those stale directories and
symlinks when `--fix` is used, including old `plugin-runtime-deps` roots, global
Node-prefix package symlinks that point at pruned `plugin-runtime-deps` targets,
`.openclaw-runtime-deps*` manifests, generated plugin `node_modules`, install
stage directories, and package-local pnpm stores.

Packaged postinstall also removes those global symlinks before pruning the
legacy target roots so upgrades do not leave dangling ESM package imports. These
paths are legacy debris only. New installs should not create them.

## Related

- [Plugins](/tools/plugin) - install path and troubleshooting
- [Manage plugins](/plugins/manage-plugins) - command examples
- [`openclaw plugins`](/cli/plugins) - full command reference
- [Plugin inventory](/plugins/plugin-inventory) - generated bundled and external plugin list
- [Plugin manifest](/plugins/manifest) - manifest and package metadata
