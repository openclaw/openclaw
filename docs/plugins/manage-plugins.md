---
summary: "Quick examples for installing, listing, uninstalling, updating, and publishing OpenClaw plugins"
read_when:
  - You want quick plugin install, list, update, or uninstall examples
  - You want to choose between ClawHub and npm plugin distribution
  - You are publishing a plugin package
title: "Manage plugins"
sidebarTitle: "Manage plugins"
doc-schema-version: 1
---

Most plugin workflows are a few commands: list, search, install, restart the
Gateway, verify, update, or uninstall.

For background and troubleshooting, start with [Plugins](/tools/plugin). For
every option and edge case, use the [`openclaw plugins`](/cli/plugins) CLI
reference.

## List plugins

```bash
openclaw plugins list
openclaw plugins list --enabled
openclaw plugins list --verbose
openclaw plugins list --json
```

Use `--json` for scripts. It includes registry diagnostics and a static
`dependencyStatus` for plugin packages that declare `dependencies` or
`optionalDependencies`.

```bash
openclaw plugins list --json \
  | jq '.plugins[] | {id, enabled, format, source, dependencyStatus}'
```

`plugins list` is a cold inventory check. It shows what OpenClaw can discover
from config, manifests, and the plugin registry; it does not prove that an
already-running Gateway process imported the plugin runtime.

## Install plugins

```bash
# Search ClawHub for plugin packages.
openclaw plugins search "calendar"
openclaw plugins search "calendar" --limit 20

# Install from ClawHub.
openclaw plugins install clawhub:<package>
openclaw plugins install clawhub:<package>@1.2.3
openclaw plugins install clawhub:<package>@beta

# Install from npm.
openclaw plugins install npm:<package>
openclaw plugins install npm:@scope/openclaw-plugin@1.2.3
openclaw plugins install npm:@scope/openclaw-plugin@beta

# Install an npm-pack tarball through npm install semantics.
openclaw plugins install npm-pack:./openclaw-plugin-1.2.3.tgz

# Install from git or a local development checkout.
openclaw plugins install git:github.com/<owner>/<repo>@v1.0.0
openclaw plugins install ./my-plugin
openclaw plugins install --link ./my-plugin

# Install a Claude-compatible marketplace plugin.
openclaw plugins marketplace list <source>
openclaw plugins install <plugin> --marketplace <source>
```

Ordinary bare package specs install through npm during the launch cutover:

```bash
openclaw plugins install <package>
```

If the bare name matches a bundled plugin id or an official external plugin id,
OpenClaw uses the built-in catalog before falling back to ordinary npm
resolution. Use an explicit prefix when the source matters.

After installing plugin code, restart the Gateway that serves your channels and
verify runtime registration:

```bash
openclaw gateway restart
openclaw plugins inspect <plugin-id> --runtime --json
```

Use `inspect --runtime` when you need proof that the plugin registered runtime
surfaces such as tools, hooks, services, Gateway methods, or plugin-owned CLI
commands.

## Update plugins

```bash
openclaw plugins update <plugin-id>
openclaw plugins update <npm-package-or-spec>
openclaw plugins update --all
openclaw plugins update <plugin-id> --dry-run
```

If a plugin was installed from an npm dist-tag such as `@beta`, later
`update <plugin-id>` calls reuse that recorded tag. Passing an explicit npm spec
switches the tracked install to that spec for future updates.

```bash
openclaw plugins update @scope/openclaw-plugin@beta
openclaw plugins update @scope/openclaw-plugin
```

The second command moves a plugin back to the registry's default release line
when it was previously pinned to an exact version or tag.

When `openclaw update` runs on the beta channel, default-line npm and ClawHub
plugin records try the matching plugin `@beta` release first. If that beta
release does not exist, OpenClaw falls back to the recorded default/latest spec.
Exact versions and explicit tags such as `@rc` or `@beta` are preserved.

## Uninstall plugins

```bash
openclaw plugins uninstall <plugin-id> --dry-run
openclaw plugins uninstall <plugin-id>
openclaw plugins uninstall <plugin-id> --keep-files
openclaw gateway restart
```

Uninstall removes the plugin's config entry, plugin index record, allow/deny
list entries, and linked load paths when applicable. Managed install
directories are removed unless you pass `--keep-files`.

In Nix mode (`OPENCLAW_NIX_MODE=1`), plugin install, update, uninstall, enable,
and disable commands are disabled. Manage those choices in the Nix source for
the install instead; for nix-openclaw, use the agent-first
[Quick Start](https://github.com/openclaw/nix-openclaw#quick-start).

## Publish plugins

You can publish external plugins to [ClawHub](https://clawhub.ai), npmjs.com, or
both.

### Publish to ClawHub

ClawHub is the primary public discovery surface for OpenClaw plugins. It gives
users searchable metadata, version history, and registry scan results before
install.

```bash
npm i -g clawhub
clawhub login
clawhub package publish your-org/your-plugin --dry-run
clawhub package publish your-org/your-plugin
clawhub package publish your-org/your-plugin@v1.0.0
```

Users install from ClawHub with:

```bash
openclaw plugins install clawhub:<package>
```

### Publish to npmjs.com

Native npm plugins must include a plugin manifest and `package.json` OpenClaw
entrypoint metadata.

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
```

Users install npm-only packages with:

```bash
openclaw plugins install npm:@acme/openclaw-plugin
openclaw plugins install npm:@acme/openclaw-plugin@beta
openclaw plugins install npm:@acme/openclaw-plugin@1.0.0
```

If the same package is also available on ClawHub, `npm:` skips ClawHub lookup
and forces npm resolution.

## Source choice

- **ClawHub:** use when you want OpenClaw-native discovery, scan summaries,
  versions, and install hints.
- **npmjs.com:** use when you already ship JavaScript packages or need npm
  dist-tags/private registry workflows.
- **Git:** use when you want to install directly from a branch, tag, or commit.
- **Local path:** use when you are developing or testing a plugin on the same
  machine.
- **Marketplace:** use when you are installing compatible Claude marketplace
  plugin entries.

## Related

- [Plugins](/tools/plugin) - install path and troubleshooting
- [`openclaw plugins`](/cli/plugins) - full CLI reference
- [ClawHub publishing](/clawhub/publishing) - publish and registry operations
- [Community plugins](/plugins/community) - discovery and docs PR policy
- [Building plugins](/plugins/building-plugins) - create a plugin package
- [Plugin manifest](/plugins/manifest) - manifest and package metadata
