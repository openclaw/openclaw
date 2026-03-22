---
summary: "CLI reference for `openclaw plugins` (list, install, marketplace, uninstall, enable/disable, doctor)"
read_when:
  - You want to install or manage Gateway plugins or compatible bundles
  - You want to debug plugin load failures
title: "plugins"
---

# `openclaw plugins`

Manage Gateway plugins/extensions and compatible bundles.

Related:

- Plugin system: [Plugins](/tools/plugin)
- Bundle compatibility: [Plugin bundles](/plugins/bundles)
- Plugin manifest + schema: [Plugin manifest](/plugins/manifest)
- Security hardening: [Security](/gateway/security)

## Commands

```bash
openclaw plugins list
openclaw plugins install <path-or-spec>
openclaw plugins inspect <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins uninstall <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins marketplace list <marketplace>
```

Bundled plugins ship with OpenClaw but start disabled. Use `plugins enable` to
activate them.

Native OpenClaw plugins must ship `openclaw.plugin.json` with an inline JSON
Schema (`configSchema`, even if empty). Compatible bundles use their own bundle
manifests instead.

`plugins list` shows `Format: openclaw` or `Format: bundle`. Verbose list/info
output also shows the bundle subtype (`codex`, `claude`, or `cursor`) plus detected bundle
capabilities.

### Install

```bash
openclaw plugins install <path-or-spec>
openclaw plugins install <npm-spec> --pin
openclaw plugins install clawhub:<package>
openclaw plugins install <plugin>@<marketplace>
openclaw plugins install <plugin> --marketplace <marketplace>
```

Security note: treat plugin installs like running code. Prefer pinned versions.

Npm specs are **registry-only** (package name + optional **exact version** or
**dist-tag**). Git/URL/file specs and semver ranges are rejected. Dependency
installs run with `--ignore-scripts` for safety.

Bare specs and `@latest` stay on the stable track. If npm resolves either of
those to a prerelease, OpenClaw stops and asks you to opt in explicitly with a
prerelease tag such as `@beta`/`@rc` or an exact prerelease version such as
`@1.2.3-beta.4`.

If a bare install spec matches a bundled plugin id (for example `diffs`), OpenClaw
installs the bundled plugin directly. To install an npm package with the same
name, use an explicit scoped spec (for example `@scope/diffs`).

Supported archives: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Claude marketplace installs are also supported.

ClawHub installs use an explicit `clawhub:<package>` locator:

```bash
openclaw plugins install clawhub:openclaw-codex-app-server
openclaw plugins install clawhub:openclaw-codex-app-server@1.2.3
```

OpenClaw downloads the package archive from ClawHub, checks the advertised
plugin API / minimum gateway compatibility, then installs it through the normal
archive path. Recorded installs keep their ClawHub source metadata for later
updates.

Use `plugin@marketplace` shorthand when the marketplace name exists in Claude's
local registry cache at `~/.claude/plugins/known_marketplaces.json`:

```bash
openclaw plugins marketplace list <marketplace-name>
openclaw plugins install <plugin-name>@<marketplace-name>
```

Use `--marketplace` when you want to pass the marketplace source explicitly:

```bash
openclaw plugins install <plugin-name> --marketplace <marketplace-name>
openclaw plugins install <plugin-name> --marketplace <owner/repo>
openclaw plugins install <plugin-name> --marketplace ./my-marketplace
```

Marketplace sources can be:

- a Claude known-marketplace name from `~/.claude/plugins/known_marketplaces.json`
- a local marketplace root or `marketplace.json` path
- a GitHub repo shorthand such as `owner/repo`
- a git URL

For local paths and archives, OpenClaw auto-detects:

- native OpenClaw plugins (`openclaw.plugin.json`)
- Codex-compatible bundles (`.codex-plugin/plugin.json`)
- Claude-compatible bundles (`.claude-plugin/plugin.json` or the default Claude
  component layout)
- Cursor-compatible bundles (`.cursor-plugin/plugin.json`)

Compatible bundles install into the normal extensions root and participate in
the same list/info/enable/disable flow. Today, bundle skills, Claude
command-skills, Claude `settings.json` defaults, Cursor command-skills, and compatible Codex hook
directories are supported; other detected bundle capabilities are shown in
diagnostics/info but are not yet wired into runtime execution.

Use `--link` to avoid copying a local directory (adds to `plugins.load.paths`):

```bash
openclaw plugins install -l ./my-plugin
```

Use `--pin` on npm installs to save the resolved exact spec (`name@version`) in
`plugins.installs` while keeping the default behavior unpinned.

### Uninstall

```bash
openclaw plugins uninstall <id>
openclaw plugins uninstall <id> --dry-run
openclaw plugins uninstall <id> --keep-files
```

`uninstall` removes plugin records from `plugins.entries`, `plugins.installs`,
the plugin allowlist, and linked `plugins.load.paths` entries when applicable.
For active memory plugins, the memory slot resets to `memory-core`.

By default, uninstall also removes the plugin install directory under the active
state dir extensions root (`$OPENCLAW_STATE_DIR/extensions/<id>`). Use
`--keep-files` to keep files on disk.

`--keep-config` is supported as a deprecated alias for `--keep-files`.

### Update

```bash
openclaw plugins update <id-or-npm-spec>
openclaw plugins update --all
openclaw plugins update <id-or-npm-spec> --dry-run
openclaw plugins update @openclaw/voice-call@beta
```

Updates apply to tracked installs in `plugins.installs`, including npm,
ClawHub, and marketplace installs.

When you pass a plugin id, OpenClaw reuses the recorded install spec for that
plugin. That means previously stored dist-tags such as `@beta` and exact pinned
versions continue to be used on later `update <id>` runs.

For npm installs, you can also pass an explicit npm package spec with a dist-tag
or exact version. OpenClaw resolves that package name back to the tracked plugin
record, updates that installed plugin, and records the new npm spec for future
id-based updates.

When a stored integrity hash exists and the fetched artifact hash changes,
OpenClaw prints a warning and asks for confirmation before proceeding. Use
global `--yes` to bypass prompts in CI/non-interactive runs.

### Inspect

```bash
openclaw plugins inspect <id>
openclaw plugins inspect <id> --json
```

Deep introspection for a single plugin. Shows identity, load status, source,
registered capabilities, hooks, tools, commands, services, gateway methods,
HTTP routes, policy flags, diagnostics, and install metadata.

Each plugin is classified by what it actually registers at runtime:

- **plain-capability** — one capability type (e.g. a provider-only plugin)
- **hybrid-capability** — multiple capability types (e.g. text + speech + images)
- **hook-only** — only hooks, no capabilities or surfaces
- **non-capability** — tools/commands/services but no capabilities

See [Plugin shapes](/plugins/architecture#plugin-shapes) for more on the capability model.

The `--json` flag outputs a machine-readable report suitable for scripting and
auditing.

`info` is an alias for `inspect`.
