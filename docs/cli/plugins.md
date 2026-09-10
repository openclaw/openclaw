---
summary: "CLI reference for `openclaw plugins` (init, build, validate, list, install, marketplace, uninstall, enable/disable, doctor)"
read_when:
  - You want to install or manage Gateway plugins or compatible bundles
  - You want to scaffold or validate a simple tool plugin
  - You want to debug plugin load failures
title: "Plugins CLI"
sidebarTitle: "Plugins"
---

Manage Gateway plugins, hook packs, and compatible bundles.

<CardGroup cols={2}>
  <Card title="Plugin system" href="/tools/plugin">
    End-user guide for installing, enabling, and troubleshooting plugins.
  </Card>
  <Card title="Manage plugins" href="/plugins/manage-plugins">
    Quick examples for install, list, update, uninstall, and publishing.
  </Card>
  <Card title="Plugin bundles" href="/plugins/bundles">
    Bundle compatibility model.
  </Card>
  <Card title="Plugin manifest" href="/plugins/manifest">
    Manifest fields and config schema.
  </Card>
  <Card title="Security" href="/gateway/security">
    Security hardening for plugin installs.
  </Card>
</CardGroup>

## Commands

```bash
openclaw plugins list [--enabled] [--verbose] [--json]
openclaw plugins search <query> [--limit <n>] [--json]
openclaw plugins install <path-or-spec> [--link] [--force] [--pin] [--accept-capabilities] [--acknowledge-install-policy-warning] [--marketplace <source>]
openclaw plugins inspect <id> [--runtime] [--json]
openclaw plugins inspect --all [--runtime] [--json]
openclaw plugins info <id>                    # alias for inspect
openclaw plugins enable <id> [--accept-capabilities]
openclaw plugins disable <id>
openclaw plugins uninstall <id> [--dry-run] [--keep-files] [--force]
openclaw plugins update <id-or-npm-spec> | --all [--dry-run]
openclaw plugins registry [--refresh] [--json]
openclaw plugins doctor [--json]
openclaw plugins init <id> [--name <name>] [--type tool|provider|feature] [--directory <path>]
openclaw plugins build [--root <path>] [--entry <path>] [--check]
openclaw plugins validate [--root <path>] [--entry <path>] [--json]
openclaw plugins pack [--root <path>] [--out <file.tgz>] [--json]
openclaw plugins marketplace entries [--offline] [--feed-profile <name>] [--json]
openclaw plugins marketplace list <source> [--json]
openclaw plugins marketplace refresh [--feed-profile <name>] [--expected-sha256 <sha256>] [--json]
```

For slow install, inspect, uninstall, or registry-refresh investigation, run the
command with `OPENCLAW_PLUGIN_LIFECYCLE_TRACE=1`. The trace writes phase timings
to stderr and keeps JSON output parseable. See [Debugging](/help/debugging#plugin-lifecycle-trace).

<Note>
In Nix mode (`OPENCLAW_NIX_MODE=1`), `openclaw.json` is immutable. `install`, `update`, `uninstall`, `enable`, and `disable` all refuse to run. Edit the Nix source for this install instead (`programs.openclaw.config` or `instances.<name>.config` for nix-openclaw), then rebuild. See the agent-first [Quick Start](https://github.com/openclaw/nix-openclaw#quick-start).
</Note>

<Note>
Bundled plugins ship with OpenClaw. Some are enabled by default (for example bundled model providers, bundled speech providers, and the bundled browser plugin); others require `plugins enable`.

Native OpenClaw plugins ship `openclaw.plugin.json` with an inline JSON Schema (`configSchema`, even if empty). Compatible bundles use their own bundle manifests instead.

`plugins list` shows `Format: openclaw` or `Format: bundle`. Verbose list/info output also shows the bundle subtype (`agent (Agent Plugins)`, `codex`, `claude`, or `cursor`) plus detected bundle capabilities.
</Note>

## Plugins pages

This page is an index. `openclaw plugins` is documented on six pages, one per
reader job. Open the page that matches your task.

| Page                                                              | Read it when                                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [Author plugins](/cli/plugins/authoring)                          | You are scaffolding, building, validating, or packing a plugin project.          |
| [Install plugins](/cli/plugins/install)                           | You are installing from ClawHub, npm, git, a path, an archive, or a marketplace. |
| [List installed plugins](/cli/plugins/list)                       | You want the installed inventory, discovery diagnostics, or the plugin index.    |
| [Uninstall and update plugins](/cli/plugins/uninstall-and-update) | You are removing a plugin, or updating one across pins, channels, and sources.   |
| [Inspect and diagnose plugins](/cli/plugins/inspect-and-diagnose) | You need plugin identity, runtime registrations, load errors, or registry state. |
| [Marketplace feeds](/cli/plugins/marketplace)                     | You are browsing, listing, or refreshing a marketplace or hosted signed feed.    |

## Where each section moved

Every section anchor from the previous single-page version keeps its id here,
so an existing link such as `/cli/plugins#registry` still resolves. Each entry
points at the page that now holds the content.

- <a id="author" />[Author](/cli/plugins/authoring#author)
- <a id="feature-scaffold-and-artifacts" />[Feature scaffold and artifacts](/cli/plugins/authoring#feature-scaffold-and-artifacts)
- <a id="provider-scaffold" />[Provider scaffold](/cli/plugins/authoring#provider-scaffold)
- <a id="install" />[Install](/cli/plugins/install#install)
- <a id="config-includes-and-invalid-config-repair" />[Config includes and invalid-config repair](/cli/plugins/install#config-includes-and-invalid-config-repair)
- <a id="force-confirmation-and-reinstall-vs-update" />[`--force` confirmation and reinstall vs update](/cli/plugins/install#force-confirmation-and-reinstall-vs-update)
- <a id="pin-scope" />[`--pin` scope](/cli/plugins/install#pin-scope)
- <a id="acknowledge-install-policy-warning" />[`--acknowledge-install-policy-warning`](/cli/plugins/install#acknowledge-install-policy-warning)
- <a id="clawhub-security-audit" />[ClawHub Security Audit](/cli/plugins/install#clawhub-security-audit)
- <a id="hook-packs-and-npm-specs" />[Hook packs and npm specs](/cli/plugins/install#hook-packs-and-npm-specs)
- <a id="git-repositories" />[Git repositories](/cli/plugins/install#git-repositories)
- <a id="archives" />[Archives](/cli/plugins/install#archives)
- <a id="marketplace-shorthand" />[Marketplace shorthand](/cli/plugins/install#marketplace-shorthand)
- <a id="marketplace-sources" />[Marketplace sources](/cli/plugins/install#marketplace-sources)
- <a id="remote-marketplace-rules" />[Remote marketplace rules](/cli/plugins/install#remote-marketplace-rules)
- <a id="list" />[List](/cli/plugins/list#list)
- <a id="param-enabled" />[`--enabled`](/cli/plugins/list#param-enabled)
- <a id="param-verbose" />[`--verbose`](/cli/plugins/list#param-verbose)
- <a id="param-json" />[`--json`](/cli/plugins/list#param-json)
- <a id="plugin-index" />[Plugin index](/cli/plugins/list#plugin-index)
- <a id="uninstall" />[Uninstall](/cli/plugins/uninstall-and-update#uninstall)
- <a id="update" />[Update](/cli/plugins/uninstall-and-update#update)
- <a id="resolving-plugin-id-vs-npm-spec" />[Resolving plugin id vs npm spec](/cli/plugins/uninstall-and-update#resolving-plugin-id-vs-npm-spec)
- <a id="beta-channel-updates" />[Beta channel updates](/cli/plugins/uninstall-and-update#beta-channel-updates)
- <a id="existing-plugin-source-choices" />[Existing plugin source choices](/cli/plugins/uninstall-and-update#existing-plugin-source-choices)
- <a id="version-checks-and-integrity-drift" />[Version checks and integrity drift](/cli/plugins/uninstall-and-update#version-checks-and-integrity-drift)
- <a id="acknowledge-install-policy-warning-on-update" />[`--acknowledge-install-policy-warning` on update](/cli/plugins/uninstall-and-update#acknowledge-install-policy-warning-on-update)
- <a id="clawhub-security-audit-on-update" />[ClawHub Security Audit on update](/cli/plugins/uninstall-and-update#clawhub-security-audit-on-update)
- <a id="inspect" />[Inspect](/cli/plugins/inspect-and-diagnose#inspect)
- <a id="doctor" />[Doctor](/cli/plugins/inspect-and-diagnose#doctor)
- <a id="registry" />[Registry](/cli/plugins/inspect-and-diagnose#registry)
- <a id="marketplace" />[Marketplace](/cli/plugins/marketplace#marketplace)

## Related

- [Building plugins](/plugins/building-plugins)
- [CLI reference](/cli)
- [ClawHub](/clawhub)
- [ClawHub CLI](/clawhub/cli) - standalone registry commands
- [ClawHub publishing](/clawhub/publishing) - owners, scopes, and release review
