---
summary: "CLI reference for `mullusi plugins` (list, install, marketplace, uninstall, enable/disable, doctor)"
read_when:
  - You want to install or manage Gateway plugins or compatible bundles
  - You want to debug plugin load failures
title: "plugins"
---

# `mullusi plugins`

Manage Gateway plugins/extensions, hook packs, and compatible bundles.

Related:

- Plugin system: [Plugins](/tools/plugin)
- Bundle compatibility: [Plugin bundles](/plugins/bundles)
- Plugin manifest + schema: [Plugin manifest](/plugins/manifest)
- Security hardening: [Security](/gateway/security)

## Commands

```bash
mullusi plugins list
mullusi plugins list --enabled
mullusi plugins list --verbose
mullusi plugins list --json
mullusi plugins install <path-or-spec>
mullusi plugins inspect <id>
mullusi plugins inspect <id> --json
mullusi plugins inspect --all
mullusi plugins info <id>
mullusi plugins enable <id>
mullusi plugins disable <id>
mullusi plugins uninstall <id>
mullusi plugins doctor
mullusi plugins update <id>
mullusi plugins update --all
mullusi plugins marketplace list <marketplace>
mullusi plugins marketplace list <marketplace> --json
```

Bundled plugins ship with Mullusi. Some are enabled by default (for example
bundled model providers, bundled speech providers, and the bundled browser
plugin); others require `plugins enable`.

Native Mullusi plugins must ship `mullusi.plugin.json` with an inline JSON
Schema (`configSchema`, even if empty). Compatible bundles use their own bundle
manifests instead.

`plugins list` shows `Format: mullusi` or `Format: bundle`. Verbose list/info
output also shows the bundle subtype (`codex`, `claude`, or `cursor`) plus detected bundle
capabilities.

### Install

```bash
mullusi plugins install <package>                      # ClawHub first, then npm
mullusi plugins install clawhub:<package>              # ClawHub only
mullusi plugins install <package> --force              # overwrite existing install
mullusi plugins install <package> --pin                # pin version
mullusi plugins install <package> --dangerously-force-unsafe-install
mullusi plugins install <path>                         # local path
mullusi plugins install <plugin>@<marketplace>         # marketplace
mullusi plugins install <plugin> --marketplace <name>  # marketplace (explicit)
mullusi plugins install <plugin> --marketplace https://github.com/<owner>/<repo>
```

Bare package names are checked against ClawHub first, then npm. Security note:
treat plugin installs like running code. Prefer pinned versions.

If config is invalid, `plugins install` normally fails closed and tells you to
run `mullusi doctor --fix` first. The only documented exception is a narrow
bundled-plugin recovery path for plugins that explicitly opt into
`mullusi.install.allowInvalidConfigRecovery`.

`--force` reuses the existing install target and overwrites an already-installed
plugin or hook pack in place. Use it when you are intentionally reinstalling
the same id from a new local path, archive, ClawHub package, or npm artifact.

`--pin` applies to npm installs only. It is not supported with `--marketplace`,
because marketplace installs persist marketplace source metadata instead of an
npm spec.

`--dangerously-force-unsafe-install` is a break-glass option for false positives
in the built-in dangerous-code scanner. It allows the install to continue even
when the built-in scanner reports `critical` findings, but it does **not**
bypass plugin `before_install` hook policy blocks and does **not** bypass scan
failures.

This CLI flag applies to plugin install/update flows. Gateway-backed skill
dependency installs use the matching `dangerouslyForceUnsafeInstall` request
override, while `mullusi skills install` remains a separate ClawHub skill
download/install flow.

`plugins install` is also the install surface for hook packs that expose
`mullusi.hooks` in `package.json`. Use `mullusi hooks` for filtered hook
visibility and per-hook enablement, not package installation.

Npm specs are **registry-only** (package name + optional **exact version** or
**dist-tag**). Git/URL/file specs and semver ranges are rejected. Dependency
installs run with `--ignore-scripts` for safety.

Bare specs and `@latest` stay on the stable track. If npm resolves either of
those to a prerelease, Mullusi stops and asks you to opt in explicitly with a
prerelease tag such as `@beta`/`@rc` or an exact prerelease version such as
`@1.2.3-beta.4`.

If a bare install spec matches a bundled plugin id (for example `diffs`), Mullusi
installs the bundled plugin directly. To install an npm package with the same
name, use an explicit scoped spec (for example `@scope/diffs`).

Supported archives: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Claude marketplace installs are also supported.

ClawHub installs use an explicit `clawhub:<package>` locator:

```bash
mullusi plugins install clawhub:mullusi-codex-app-server
mullusi plugins install clawhub:mullusi-codex-app-server@1.2.3
```

Mullusi now also prefers ClawHub for bare npm-safe plugin specs. It only falls
back to npm if ClawHub does not have that package or version:

```bash
mullusi plugins install mullusi-codex-app-server
```

Mullusi downloads the package archive from ClawHub, checks the advertised
plugin API / minimum gateway compatibility, then installs it through the normal
archive path. Recorded installs keep their ClawHub source metadata for later
updates.

Use `plugin@marketplace` shorthand when the marketplace name exists in Claude's
local registry cache at `~/.claude/plugins/known_marketplaces.json`:

```bash
mullusi plugins marketplace list <marketplace-name>
mullusi plugins install <plugin-name>@<marketplace-name>
```

Use `--marketplace` when you want to pass the marketplace source explicitly:

```bash
mullusi plugins install <plugin-name> --marketplace <marketplace-name>
mullusi plugins install <plugin-name> --marketplace <owner/repo>
mullusi plugins install <plugin-name> --marketplace https://github.com/<owner>/<repo>
mullusi plugins install <plugin-name> --marketplace ./my-marketplace
```

Marketplace sources can be:

- a Claude known-marketplace name from `~/.claude/plugins/known_marketplaces.json`
- a local marketplace root or `marketplace.json` path
- a GitHub repo shorthand such as `owner/repo`
- a GitHub repo URL such as `https://github.com/owner/repo`
- a git URL

For remote marketplaces loaded from GitHub or git, plugin entries must stay
inside the cloned marketplace repo. Mullusi accepts relative path sources from
that repo and rejects HTTP(S), absolute-path, git, GitHub, and other non-path
plugin sources from remote manifests.

For local paths and archives, Mullusi auto-detects:

- native Mullusi plugins (`mullusi.plugin.json`)
- Codex-compatible bundles (`.codex-plugin/plugin.json`)
- Claude-compatible bundles (`.claude-plugin/plugin.json` or the default Claude
  component layout)
- Cursor-compatible bundles (`.cursor-plugin/plugin.json`)

Compatible bundles install into the normal extensions root and participate in
the same list/info/enable/disable flow. Today, bundle skills, Claude
command-skills, Claude `settings.json` defaults, Claude `.lsp.json` /
manifest-declared `lspServers` defaults, Cursor command-skills, and compatible
Codex hook directories are supported; other detected bundle capabilities are
shown in diagnostics/info but are not yet wired into runtime execution.

### List

```bash
mullusi plugins list
mullusi plugins list --enabled
mullusi plugins list --verbose
mullusi plugins list --json
```

Use `--enabled` to show only loaded plugins. Use `--verbose` to switch from the
table view to per-plugin detail lines with source/origin/version/activation
metadata. Use `--json` for machine-readable inventory plus registry
diagnostics.

Use `--link` to avoid copying a local directory (adds to `plugins.load.paths`):

```bash
mullusi plugins install -l ./my-plugin
```

`--force` is not supported with `--link` because linked installs reuse the
source path instead of copying over a managed install target.

Use `--pin` on npm installs to save the resolved exact spec (`name@version`) in
`plugins.installs` while keeping the default behavior unpinned.

### Uninstall

```bash
mullusi plugins uninstall <id>
mullusi plugins uninstall <id> --dry-run
mullusi plugins uninstall <id> --keep-files
```

`uninstall` removes plugin records from `plugins.entries`, `plugins.installs`,
the plugin allowlist, and linked `plugins.load.paths` entries when applicable.
For active memory plugins, the memory slot resets to `memory-core`.

By default, uninstall also removes the plugin install directory under the active
state-dir plugin root. Use
`--keep-files` to keep files on disk.

`--keep-config` is supported as a deprecated alias for `--keep-files`.

### Update

```bash
mullusi plugins update <id-or-npm-spec>
mullusi plugins update --all
mullusi plugins update <id-or-npm-spec> --dry-run
mullusi plugins update @mullusi/voice-call@beta
mullusi plugins update mullusi-codex-app-server --dangerously-force-unsafe-install
```

Updates apply to tracked installs in `plugins.installs` and tracked hook-pack
installs in `hooks.internal.installs`.

When you pass a plugin id, Mullusi reuses the recorded install spec for that
plugin. That means previously stored dist-tags such as `@beta` and exact pinned
versions continue to be used on later `update <id>` runs.

For npm installs, you can also pass an explicit npm package spec with a dist-tag
or exact version. Mullusi resolves that package name back to the tracked plugin
record, updates that installed plugin, and records the new npm spec for future
id-based updates.

When a stored integrity hash exists and the fetched artifact hash changes,
Mullusi prints a warning and asks for confirmation before proceeding. Use
global `--yes` to bypass prompts in CI/non-interactive runs.

`--dangerously-force-unsafe-install` is also available on `plugins update` as a
break-glass override for built-in dangerous-code scan false positives during
plugin updates. It still does not bypass plugin `before_install` policy blocks
or scan-failure blocking, and it only applies to plugin updates, not hook-pack
updates.

### Inspect

```bash
mullusi plugins inspect <id>
mullusi plugins inspect <id> --json
```

Deep introspection for a single plugin. Shows identity, load status, source,
registered capabilities, hooks, tools, commands, services, gateway methods,
HTTP routes, policy flags, diagnostics, install metadata, bundle capabilities,
and any detected MCP or LSP server support.

Each plugin is classified by what it actually registers at runtime:

- **plain-capability** — one capability type (e.g. a provider-only plugin)
- **hybrid-capability** — multiple capability types (e.g. text + speech + images)
- **hook-only** — only hooks, no capabilities or surfaces
- **non-capability** — tools/commands/services but no capabilities

See [Plugin shapes](/plugins/architecture#plugin-shapes) for more on the capability model.

The `--json` flag outputs a machine-readable report suitable for scripting and
auditing.

`inspect --all` renders a fleet-wide table with shape, capability kinds,
compatibility notices, bundle capabilities, and hook summary columns.

`info` is an alias for `inspect`.

### Doctor

```bash
mullusi plugins doctor
```

`doctor` reports plugin load errors, manifest/discovery diagnostics, and
compatibility notices. When everything is clean it prints `No plugin issues
detected.`

### Marketplace

```bash
mullusi plugins marketplace list <source>
mullusi plugins marketplace list <source> --json
```

Marketplace list accepts a local marketplace path, a `marketplace.json` path, a
GitHub shorthand like `owner/repo`, a GitHub repo URL, or a git URL. `--json`
prints the resolved source label plus the parsed marketplace manifest and
plugin entries.
